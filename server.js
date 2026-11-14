
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(process.cwd(), "data");
const IMAGES = path.join(process.cwd(), "outputs", "images");
const STATE = path.join(DATA, "progress.json");

app.use(express.json({ limit: "2mb" }));

await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(IMAGES, { recursive: true });

async function getState() {
  try {
    return JSON.parse(await fs.readFile(STATE, "utf8"));
  } catch {
    return { products: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE, JSON.stringify(state, null, 2));
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 150);
}

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perfume Image Tool</title>
<style>
body{font-family:Arial;background:#f5f5f5;color:#222;padding:15px;margin:0}
main{max-width:850px;margin:auto}
.panel{background:white;padding:15px;margin:15px 0;border-radius:12px}
textarea,input{width:100%;box-sizing:border-box;padding:12px;margin:8px 0;border:1px solid #ccc;border-radius:7px;font-size:15px}
textarea{height:150px}
button{padding:12px;border:0;border-radius:7px;background:#222;color:white;margin:4px;cursor:pointer}
button:disabled{opacity:.5}
#productList button{display:block;width:100%;text-align:left;background:#eee;color:#222}
#productList button.active{background:#222;color:white}
#results{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.result{background:#fafafa;border:1px solid #ddd;border-radius:8px;padding:8px;overflow:hidden}
.result img{width:100%;aspect-ratio:1;object-fit:contain;background:#eee}
.result p{font-size:12px;overflow-wrap:anywhere}
.result button{width:100%}
.small{font-size:13px;color:#666}
#status{white-space:pre-wrap;font-size:14px}
a{display:block;margin:10px 0}
</style>
</head>
<body>
<main>
<h2>Perfume Image Tool</h2>
<p class="small">Find, select and save product images at 500 × 500 pixels.</p>

<section class="panel">
<h3>1. Product list</h3>
<p class="small">One product per line:<br>
Product name | reseller price | retail price</p>
<textarea id="input" placeholder="Gift Set Example Perfume | 25000 | 35000"></textarea>
<button onclick="loadProducts()">Load products</button>
</section>

<section class="panel">
<h3>2. Your products</h3>
<p id="progress" class="small"></p>
<div id="productList"></div>
</section>

<section class="panel" id="workspace" hidden>
<h3 id="name"></h3>
<p id="prices" class="small"></p>

<button onclick="searchImages()">Search images</button>
<button onclick="suggestTitle()">Suggest title with AI</button>

<p id="query" class="small"></p>
<label><b>Canonical product title</b></label>
<input id="title" placeholder="Enter or edit the product title">

<p id="status"></p>
<div id="results"></div>

<hr>
<button onclick="skipProduct()">Skip product</button>
<button onclick="nextProduct()">Next pending product</button>
</section>

<section class="panel">
<h3>3. Export</h3>
<button onclick="exportFiles()">Generate output files</button>
<div id="downloads"></div>
</section>
</main>

<script>
let products = [];
let currentId = null;
const el = id => document.getElementById(id);

async function post(url, body) {
  const response = await fetch(url, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function status(message) {
  el("status").textContent = message;
}

function escapeHTML(value) {
  return String(value || "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])
  );
}

async function refresh() {
  const response = await fetch("/api/state");
  const data = await response.json();
  products = data.products || [];
  renderList();
  renderProgress();
}

function renderProgress() {
  const selected = products.filter(p => p.status === "selected").length;
  const skipped = products.filter(p => p.status === "skipped").length;
  const pending = products.filter(p => p.status === "pending").length;
  el("progress").textContent =
    products.length + " products · " + selected +
    " selected · " + skipped + " skipped · " + pending + " pending";
}

function renderList() {
  el("productList").innerHTML = products.map(p =>
    '<button class="' + (p.id === currentId ? "active" : "") +
    '" onclick="selectProduct(\\'' + p.id + '\\')">' +
    escapeHTML(p.name) + " — " + escapeHTML(p.status) + "</button>"
  ).join("");
}

function selectProduct(id) {
  currentId = id;
  const p = products.find(x => x.id === id);
  if (!p) return;

  el("workspace").hidden = false;
  el("name").textContent = p.name;
  el("prices").textContent =
    "Reseller: " + p.reseller + " | Retail: " + p.retail;
  el("title").value = p.canonicalTitle || "";
  el("query").textContent = "Search query: " + p.name;
  renderResults(p.results || []);
  renderList();
  status("");
}

function renderResults(results) {
  el("results").innerHTML = results.map((r, i) =>
    '<div class="result">' +
    '<img src="' + escapeHTML(r.thumbnail || r.original) + '" loading="lazy">' +
    '<p><b>' + escapeHTML(r.title) + '</b></p>' +
    '<p>' + escapeHTML(r.source) + '</p>' +
    '<button onclick="chooseImage(' + i + ')">Choose image</button></div>'
  ).join("");
}

async function loadProducts() {
  const lines = el("input").value.split("\\n").map(x => x.trim()).filter(Boolean);
  const list = [];

  for (const line of lines) {
    const parts = line.split("|").map(x => x.trim());
    if (parts.length !== 3 || parts.some(x => !x)) {
      alert("Check this line. Use: product name | reseller price | retail price\\n\\n" + line);
      return;
    }
    list.push({name:parts[0],reseller:parts[1],retail:parts[2]});
  }

  if (!list.length) return alert("Paste your product list first.");
  if (!confirm("Load " + list.length + " products? This replaces the current list.")) return;

  try {
    const data = await post("/api/products",{products:list});
    await refresh();
    if (data.products.length) selectProduct(data.products[0].id);
  } catch(e) { alert(e.message); }
}

async function searchImages() {
  status("Searching Google Images...");
  el("results").innerHTML = "";
  try {
    const data = await post("/api/search",{id:currentId});
    renderResults(data.results);
    await refresh();
    status(data.results.length ? "Choose the correct image." : "No results found.");
  } catch(e) { status(e.message); }
}

async function suggestTitle() {
  status("Asking Gemini for a title suggestion...");
  try {
    const data = await post("/api/suggest-title",{id:currentId});
    el("title").value = data.title;
    status("Suggestion ready. Check the title before saving.");
  } catch(e) { status(e.message); }
}

async function chooseImage(index) {
  const p = products.find(x => x.id === currentId);
  const result = p?.results?.[index];
  const title = el("title").value.trim();

  if (!result) return;
  if (!title) return alert("Enter a product title first.");

  if (!confirm("Save image as " + title + ".jpg?")) return;
  status("Downloading and processing image...");

  try {
    const data = await post("/api/select",{
      id:currentId,imageUrl:result.original || result.thumbnail,title
    });
    await refresh();
    status("Image saved: " + data.filename);
  } catch(e) { status(e.message); }
}

async function skipProduct() {
  if (!confirm("Skip this product?")) return;
  try {
    await post("/api/skip",{id:currentId});
    await refresh();
    status("Product skipped.");
  } catch(e) { status(e.message); }
}

function nextProduct() {
  const next = products.find(p => p.status === "pending");
  if (!next) return status("No pending products.");
  selectProduct(next.id);
}

async function exportFiles() {
  try {
    await post("/api/export",{});
    el("downloads").innerHTML =
      '<a href="/download/products.txt">Download product list</a>' +
      '<a href="/download/skipped.txt">Download skipped products</a>' +
      '<a href="/download/progress.json">Download progress JSON</a>';
  } catch(e) { alert(e.message); }
}

refresh();
</script>
</body>
</html>`);
});

app.get("/api/state", async (req, res) => {
  res.json(await getState());
});

app.post("/api/products", async (req, res) => {
  const input = req.body.products;
  if (!Array.isArray(input) || !input.length)
    return res.status(400).json({error:"No products supplied."});

  const products = input.map((p,i) => ({
    id:String(i+1),
    name:String(p.name || "").trim(),
    reseller:String(p.reseller || "").trim(),
    retail:String(p.retail || "").trim(),
    canonicalTitle:"",
    status:"pending",
    results:[],
    imagePath:""
  }));

  if (products.some(p => !p.name || !p.reseller || !p.retail))
    return res.status(400).json({error:"Every product needs all three fields."});

  const state = {products};
  await saveState(state);
  res.json(state);
});

app.post("/api/search", async (req,res) => {
  try {
    if (!process.env.SERPAPI_API_KEY)
      throw new Error("SERPAPI_API_KEY is missing from Codespaces secrets.");

    const state = await getState();
    const p = state.products.find(x => x.id === String(req.body.id));
    if (!p) throw new Error("Product not found.");

    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine","google_images");
    url.searchParams.set("q",p.name);
    url.searchParams.set("api_key",process.env.SERPAPI_API_KEY);

    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Image search failed.");

    p.results = (data.images_results || []).slice(0,8).map(r => ({
      title:r.title || "",
      source:r.source || "",
      thumbnail:r.thumbnail || "",
      original:r.original || ""
    }));
    await saveState(state);
    res.json({results:p.results});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post("/api/suggest-title", async (req,res) => {
  try {
    if (!process.env.GEMINI_API_KEY)
      throw new Error("GEMINI_API_KEY is missing from Codespaces secrets.");

    const state = await getState();
    const p = state.products.find(x => x.id === String(req.body.id));
    if (!p) throw new Error("Product not found.");

    if (p.canonicalTitle) return res.json({title:p.canonicalTitle});

    const evidence = (p.results || []).slice(0,8).map(r =>
      r.title + " — " + r.source
    ).join("\\n");

    const prompt = "Suggest a clean, accurate canonical perfume product title. " +
      "Use the brand, fragrance name, concentration if supported, and gift set " +
      "details only when supported by the evidence. Do not invent contents. " +
      "The supplier's name is: " + p.name +
      ". Search result titles and sources:\\n" + evidence +
      "\\nReturn only the suggested title.";

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=" +
      encodeURIComponent(process.env.GEMINI_API_KEY),
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          contents:[{parts:[{text:prompt}]}]
        })
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Gemini request failed.");

    const title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!title) throw new Error("Gemini returned no title.");

    p.canonicalTitle = title.replace(/^["']|["']$/g,"").trim();
    await saveState(state);
    res.json({title:p.canonicalTitle});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post("/api/select", async (req,res) => {
  try {
    const state = await getState();
    const p = state.products.find(x => x.id === String(req.body.id));
    if (!p) throw new Error("Product not found.");

    const title = safeName(String(req.body.title || ""));
    if (!title) throw new Error("Enter a valid title.");

    const imageUrl = new URL(req.body.imageUrl);
    if (!["https:"].includes(imageUrl.protocol))
      throw new Error("Image URL must use HTTPS.");

    const response = await fetch(imageUrl, {signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error("Could not download image.");

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 15 * 1024 * 1024)
      throw new Error("Image is too large.");

    const filename = title + ".jpg";
    const destination = path.join(IMAGES,filename);

    await sharp(bytes)
      .resize(500,500,{fit:"cover",position:"centre"})
      .jpeg({quality:90})
      .toFile(destination);

    p.canonicalTitle = title;
    p.status = "selected";
    p.imagePath = "outputs/images/" + filename;
    await saveState(state);

    res.json({filename});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post("/api/skip", async (req,res) => {
  const state = await getState();
  const p = state.products.find(x => x.id === String(req.body.id));
  if (!p) return res.status(404).json({error:"Product not found."});
  p.status = "skipped";
  await saveState(state);
  res.json({success:true});
});

app.post("/api/export", async (req,res) => {
  const state = await getState();

  const selected = state.products.filter(p => p.status === "selected");
  const skipped = state.products.filter(p => p.status !== "selected");

  const lines = selected.map(p =>
    p.canonicalTitle + " - " + p.reseller + " - " + p.retail
  );

  await fs.writeFile(
    path.join(process.cwd(),"outputs","products.txt"),
    lines.join("\\n")
  );
  await fs.writeFile(
    path.join(process.cwd(),"outputs","skipped.txt"),
    skipped.map(p => p.name).join("\\n")
  );
  await fs.writeFile(
    path.join(process.cwd(),"outputs","progress.json"),
    JSON.stringify(state,null,2)
  );

  res.json({success:true});
});

app.get("/download/:file", async (req,res) => {
  const allowed = {
    "products.txt":"products.txt",
    "skipped.txt":"skipped.txt",
    "progress.json":"progress.json"
  };
  const file = allowed[req.params.file];
  if (!file) return res.sendStatus(404);
  res.download(path.join(process.cwd(),"outputs",file));
});

app.listen(PORT,"0.0.0.0",() => {
  console.log("Perfume Image Tool running on port " + PORT);
});
