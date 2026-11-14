import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import archiver from "archiver";

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const OUTPUTS = path.join(ROOT, "outputs");
const IMAGES = path.join(OUTPUTS, "images");
const STATE = path.join(DATA, "progress.json");

app.use(express.json({ limit: "2mb" }));

await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(IMAGES, { recursive: true });
await fs.mkdir(OUTPUTS, { recursive: true });

async function getState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE, "utf8"));
    state.products = Array.isArray(state.products) ? state.products : [];
    return state;
  } catch {
    return { products: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE, JSON.stringify(state, null, 2));
}

function safeName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function getProduct(state, id) {
  return state.products.find(product => product.id === String(id));
}

async function searchProduct(p) {
  if (!process.env.SERPAPI_API_KEY) {
    throw new Error("SERPAPI_API_KEY is missing from Codespaces secrets.");
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", p.name);
  url.searchParams.set("api_key", process.env.SERPAPI_API_KEY);

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Google Images search failed.");

  p.results = (data.images_results || []).slice(0, 8).map(result => ({
    title: result.title || "",
    source: result.source || "",
    thumbnail: result.thumbnail || "",
    original: result.original || ""
  }));
  p.searchCompleted = true;
  return p.results;
}

const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestGemini(model, prompt) {
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  );
  url.searchParams.set("key", process.env.GEMINI_API_KEY);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 120 }
    }),
    signal: AbortSignal.timeout(45000)
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || `Gemini returned HTTP ${response.status}.`);
    error.status = response.status;
    error.apiStatus = data.error?.status || "";
    throw error;
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned no title.");
  return text.replace(/^['"“”]+|['"“”]+$/g, "").replace(/^```.*\n|\n```$/g, "").trim();
}

async function suggestCanonicalTitle(p) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing from Codespaces secrets.");
  }
  if (p.canonicalTitle) return p.canonicalTitle;

  const evidence = (p.results || []).slice(0, 8).map((result, index) =>
    `${index + 1}. ${result.title} — ${result.source}`
  ).join("\n");

  const prompt = [
    "Create one accurate, clean product title for an online perfume store.",
    "Use the supplier's product name as the main evidence and search result titles only to clarify spelling, brand, fragrance name, concentration, or set details.",
    "Keep the product type and gift-set wording when supplied.",
    "Include EDP, EDT, parfum, or other concentration only when supported.",
    "Mention set contents only when clearly supported by the evidence. Never guess or invent contents, sizes, or concentration.",
    "Remove prices, seller names, promotional wording, and irrelevant search-result noise.",
    "Return only the final title, with no quotation marks or explanation.",
    `Supplier product name: ${p.name}`,
    `Google Images result evidence:\n${evidence || "No image result evidence available."}`
  ].join("\n\n");

  const attempts = [
    { model: GEMINI_MODELS[0], wait: 1500 },
    { model: GEMINI_MODELS[0], wait: 3500 },
    { model: GEMINI_MODELS[1], wait: 2500 },
    { model: GEMINI_MODELS[1], wait: 4500 }
  ];
  let lastError;

  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await sleep(attempts[i].wait);
    try {
      return await requestGemini(attempts[i].model, prompt);
    } catch (error) {
      lastError = error;
      const temporary = error.status === 429 || error.status === 500 ||
        error.status === 502 || error.status === 503 || error.status === 504 ||
        error.apiStatus === "RESOURCE_EXHAUSTED" || error.apiStatus === "UNAVAILABLE";
      if (!temporary) break;
    }
  }
  throw lastError || new Error("Gemini could not generate a title.");
}

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta charset="utf-8">
<title>Perfume Image Tool</title>
<style>
*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f4f4f5;color:#202024;padding:14px;margin:0}main{max-width:760px;margin:auto}.panel{background:#fff;padding:16px;margin:14px 0;border-radius:13px;box-shadow:0 1px 4px #0000000b}h2{margin:8px 0}h3{margin:0 0 12px}.small{font-size:13px;color:#686872;line-height:1.5}textarea,input{width:100%;padding:12px;margin:8px 0;border:1px solid #d5d5da;border-radius:8px;font-size:15px}textarea{height:145px;resize:vertical}button{padding:12px 15px;border:0;border-radius:8px;background:#242429;color:white;font-size:14px;font-weight:600;margin:4px 3px 4px 0;cursor:pointer}button:disabled{opacity:.45;cursor:wait}.secondary{background:#e9e9ed;color:#242429}.danger{background:#8d3030}#progressTrack{height:8px;background:#e7e7eb;border-radius:20px;overflow:hidden;margin:10px 0}#progressFill{height:100%;width:0;background:#29292f;transition:width .2s}#counter{font-size:14px;font-weight:700}#results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}.result{background:#fafafa;border:1px solid #e1e1e5;border-radius:10px;padding:8px;min-width:0}.result img{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:#eee;border-radius:6px}.result p{font-size:12px;overflow-wrap:anywhere;line-height:1.4}.result button{width:100%;margin:4px 0}.result button:disabled{opacity:.5}#status{white-space:pre-wrap;font-size:14px;line-height:1.5;margin:12px 0}a{display:block;margin:12px 0;color:#2456a6;overflow-wrap:anywhere}.hidden{display:none!important}.actions{display:flex;flex-wrap:wrap;gap:6px}.actions button{flex:1}.topline{display:flex;justify-content:space-between;gap:10px;align-items:center}
</style>
</head>
<body>
<main>
<h2>Perfume Image Tool</h2>
<p class="small">Choose the correct product image. The tool saves it at 500 × 500 pixels and moves to the next product automatically.</p>

<section class="panel" id="importPanel">
<h3>1. Product list</h3>
<p class="small">One product per line:<br>Product name | reseller price | retail price</p>
<textarea id="input" placeholder="Gift Set Example Perfume | 25000 | 35000"></textarea>
<button id="loadButton" onclick="loadProducts()">Load products</button>
</section>

<section class="panel" id="workPanel" hidden>
<div class="topline"><h3>2. Image selection</h3><span id="counter"></span></div>
<div id="progressTrack"><div id="progressFill"></div></div>
<p id="summary" class="small"></p>
<h3 id="name"></h3>
<p id="prices" class="small"></p>
<p id="status" role="status" aria-live="polite">Preparing product…</p>
<p id="query" class="small"></p>
<label for="title"><b>Canonical product title</b></label>
<input id="title" placeholder="AI suggestion will appear here">
<div id="retryActions" class="hidden">
<button class="secondary" id="retrySearchButton" onclick="retrySearch()">Retry image search</button>
<button class="secondary" id="retryTitleButton" onclick="retryTitle()">Retry AI title</button>
</div>
<div id="results"></div>
<hr style="border:0;border-top:1px solid #eee;margin:18px 0">
<button class="danger" id="skipButton" onclick="skipProduct()">Skip this product</button>
</section>

<section class="panel">
<h3>3. Export your work</h3>
<p class="small">Download the selected 500 × 500 images together, plus your product list.</p>
<button onclick="exportFiles()">Generate output files</button>
<div id="downloads">
<a href="/download/images.zip">Download selected images (ZIP)</a>
</div>
</section>
</main>

<script>
let products = [];
let currentId = null;
let busy = false;
const el = id => document.getElementById(id);

async function post(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function escapeHTML(value) {
  return String(value || "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])
  );
}

function setStatus(message) { el("status").textContent = message; }

async function refresh() {
  const response = await fetch("/api/state");
  const data = await response.json();
  products = data.products || [];
  renderProgress();
}

function renderProgress() {
  const selected = products.filter(p => p.status === "selected").length;
  const skipped = products.filter(p => p.status === "skipped").length;
  const completed = selected + skipped;
  const total = products.length;
  el("summary").textContent = \`\${selected} selected · \${skipped} skipped · \${total - completed} remaining\`;
  const position = Math.max(0, products.findIndex(p => p.id === currentId) + 1);
  el("counter").textContent = total ? \`\${position || completed + 1} of \${total}\` : "";
  el("progressFill").style.width = total ? \`\${completed / total * 100}%\` : "0%";
}

function renderResults(results) {
  el("results").innerHTML = results.map((r, i) =>
    \`<div class="result">
      <img src="\${escapeHTML(r.thumbnail || r.original)}" alt="Image result \${i + 1}" loading="lazy">
      <p><b>\${escapeHTML(r.title || "Image result")}</b></p>
      <p>\${escapeHTML(r.source)}</p>
      <button onclick="chooseImage(\${i})">Choose this image</button>
    </div>\`
  ).join("");
}

function setBusy(value) {
  busy = value;
  el("skipButton").disabled = value;
  document.querySelectorAll("#results button").forEach(button => button.disabled = value);
}

async function prepareCurrent() {
  const p = products.find(item => item.id === currentId);
  if (!p) return;
  el("workPanel").hidden = false;
  el("name").textContent = p.name;
  el("prices").textContent = \`Reseller: \${p.reseller} | Retail: \${p.retail}\`;
  el("query").textContent = \`Google Images search: \${p.name}\`;
  el("title").value = p.canonicalTitle || "";
  el("results").innerHTML = "";
  el("retryActions").classList.add("hidden");
  el("retrySearchButton").classList.add("hidden");
  el("retryTitleButton").classList.add("hidden");
  renderProgress();
  setBusy(true);
  setStatus("Searching Google Images…");

  try {
    const data = await post("/api/prepare", { id: currentId });
    await refresh();
    el("title").value = data.title || p.canonicalTitle || "";
    renderResults(data.results || []);

    if (data.searchError) {
      setStatus("Image search failed: " + data.searchError + "\\nYou can retry the search or skip this product.");
      el("retryActions").classList.remove("hidden");
      el("retrySearchButton").classList.remove("hidden");
    } else if (!data.results?.length) {
      setStatus("No Google Images results were found. You can retry the search or skip this product.");
      el("retryActions").classList.remove("hidden");
      el("retrySearchButton").classList.remove("hidden");
    } else if (data.titleError) {
      setStatus("Images are ready, but the AI title could not be generated: " + data.titleError + "\\nYou can enter the title yourself or retry AI.");
      el("retryActions").classList.remove("hidden");
      el("retryTitleButton").classList.remove("hidden");
    } else {
      setStatus("Images and title are ready. Check the title, then choose the correct image.");
    }
  } catch (error) {
    setStatus(error.message + "\\nYou can retry image search or skip this product.");
    el("retryActions").classList.remove("hidden");
    el("retrySearchButton").classList.remove("hidden");
  } finally {
    setBusy(false);
    renderProgress();
  }
}

async function loadProducts() {
  const lines = el("input").value.split("\\n").map(line => line.trim()).filter(Boolean);
  const list = [];
  for (const line of lines) {
    const parts = line.split("|").map(part => part.trim());
    if (parts.length !== 3 || parts.some(part => !part)) {
      alert("Check this line. Use: product name | reseller price | retail price\\n\\n" + line);
      return;
    }
    list.push({ name: parts[0], reseller: parts[1], retail: parts[2] });
  }
  if (!list.length) return alert("Paste your product list first.");
  if (!confirm(\`Load \${list.length} products? This replaces the current list and saved progress.\`)) return;

  el("loadButton").disabled = true;
  try {
    const data = await post("/api/products", { products: list });
    await refresh();
    el("workPanel").hidden = false;
    if (data.products.length) {
      currentId = data.products[0].id;
      await prepareCurrent();
    }
  } catch (error) { alert(error.message); }
  finally { el("loadButton").disabled = false; }
}

async function retrySearch() {
  if (busy || !currentId) return;
  setBusy(true);
  setStatus("Retrying Google Images search…");
  try {
    const data = await post("/api/retry-search", { id: currentId });
    await refresh();
    renderResults(data.results || []);
    if (data.results?.length) {
      setStatus("Images are ready. Choose the correct image.");
      el("retryActions").classList.add("hidden");
      setBusy(false);
      await retryTitleIfMissing();
    } else {
      setStatus("No results found. You can skip this product.");
      el("retryActions").classList.remove("hidden");
      el("retrySearchButton").classList.remove("hidden");
    }
  } catch (error) {
    setStatus(error.message);
    el("retryActions").classList.remove("hidden");
    el("retrySearchButton").classList.remove("hidden");
  } finally { setBusy(false); }
}

async function retryTitleIfMissing() {
  const p = products.find(item => item.id === currentId);
  if (p?.canonicalTitle) return;
  await retryTitle();
}

async function retryTitle() {
  if (busy || !currentId) return;
  setBusy(true);
  setStatus("Asking Gemini to suggest a title…");
  try {
    const data = await post("/api/retry-title", { id: currentId });
    el("title").value = data.title;
    await refresh();
    setStatus("Title suggestion ready. Check it before choosing an image.");
    el("retryActions").classList.add("hidden");
  } catch (error) {
    setStatus("AI title failed: " + error.message + "\\nYou can enter a title manually.");
    el("retryActions").classList.remove("hidden");
    el("retryTitleButton").classList.remove("hidden");
  }
  finally { setBusy(false); }
}

async function chooseImage(index) {
  if (busy) return;
  const p = products.find(item => item.id === currentId);
  const result = p?.results?.[index];
  const title = el("title").value.trim();
  if (!result) return;
  if (!title) return alert("Enter a product title first.");
  if (!confirm("Save image as " + title + ".jpg and move to the next product?")) return;

  setBusy(true);
  setStatus("Downloading and processing image at 500 × 500…");
  try {
    const data = await post("/api/select", {
      id: currentId,
      imageUrl: result.original || result.thumbnail,
      title
    });
    await refresh();
    setStatus("Saved " + data.filename + ". Loading the next product…");
    await advanceToNext();
  } catch (error) {
    setStatus("Could not save image: " + error.message);
    setBusy(false);
  }
}

async function skipProduct() {
  if (busy || !currentId) return;
  if (!confirm("Skip this product and move to the next one?")) return;
  setBusy(true);
  try {
    await post("/api/skip", { id: currentId });
    await refresh();
    await advanceToNext();
  } catch (error) {
    setStatus(error.message);
    setBusy(false);
  }
}

async function advanceToNext() {
  const next = products.find(product => product.status === "pending");
  if (!next) {
    currentId = null;
    el("workPanel").hidden = false;
    el("counter").textContent = \`\${products.length} of \${products.length}\`;
    el("progressFill").style.width = "100%";
    el("name").textContent = "All products processed";
    el("prices").textContent = "";
    el("query").textContent = "";
    el("title").value = "";
    el("results").innerHTML = "";
    el("retryActions").classList.add("hidden");
    setStatus("You're finished. Generate your output files and download the images ZIP below.");
    el("skipButton").disabled = true;
    setBusy(false);
    renderProgress();
    return;
  }
  currentId = next.id;
  await prepareCurrent();
}

async function exportFiles() {
  try {
    await post("/api/export", {});
    el("downloads").innerHTML =
      '<a href="/download/images.zip">Download selected images (ZIP)</a>' +
      '<a href="/download/products.txt">Download product list</a>' +
      '<a href="/download/skipped.txt">Download skipped products</a>' +
      '<a href="/download/progress.json">Download progress JSON</a>';
  } catch (error) { alert(error.message); }
}

async function resume() {
  await refresh();
  const firstPending = products.find(product => product.status === "pending");
  if (firstPending) {
    currentId = firstPending.id;
    el("workPanel").hidden = false;
    await prepareCurrent();
  } else if (products.length) {
    currentId = null;
    el("workPanel").hidden = false;
    el("counter").textContent = \`\${products.length} of \${products.length}\`;
    el("progressFill").style.width = "100%";
    el("name").textContent = "All products processed";
    setStatus("You're finished. Generate your output files and download the images ZIP below.");
    el("skipButton").disabled = true;
  }
}

resume().catch(error => setStatus(error.message));
</script>
</body>
</html>`);
});

app.get("/api/state", async (req, res) => {
  res.json(await getState());
});

app.post("/api/products", async (req, res) => {
  const input = req.body.products;
  if (!Array.isArray(input) || !input.length) {
    return res.status(400).json({ error: "No products supplied." });
  }

  const products = input.map((product, index) => ({
    id: String(index + 1),
    name: String(product.name || "").trim(),
    reseller: String(product.reseller || "").trim(),
    retail: String(product.retail || "").trim(),
    canonicalTitle: "",
    status: "pending",
    results: [],
    searchCompleted: false,
    imagePath: ""
  }));

  if (products.some(product => !product.name || !product.reseller || !product.retail)) {
    return res.status(400).json({ error: "Every product needs all three fields." });
  }

  const state = { products };
  await saveState(state);
  res.json(state);
});

app.post("/api/prepare", async (req, res) => {
  const state = await getState();
  const p = getProduct(state, req.body.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  if (p.status !== "pending") return res.status(400).json({ error: "This product is already completed." });

  let searchError = "";
  let titleError = "";

  if (!p.searchCompleted) {
    try {
      await searchProduct(p);
      await saveState(state);
    } catch (error) {
      searchError = error.message;
    }
  }

  if (!searchError && p.results.length && !p.canonicalTitle) {
    try {
      p.canonicalTitle = await suggestCanonicalTitle(p);
      await saveState(state);
    } catch (error) {
      titleError = error.message;
    }
  }

  res.json({ results: p.results || [], title: p.canonicalTitle || "", searchError, titleError });
});

app.post("/api/retry-search", async (req, res) => {
  try {
    const state = await getState();
    const p = getProduct(state, req.body.id);
    if (!p) throw new Error("Product not found.");
    p.searchCompleted = false;
    p.results = [];
    await searchProduct(p);
    await saveState(state);
    res.json({ results: p.results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/retry-title", async (req, res) => {
  try {
    const state = await getState();
    const p = getProduct(state, req.body.id);
    if (!p) throw new Error("Product not found.");
    p.canonicalTitle = "";
    const title = await suggestCanonicalTitle(p);
    p.canonicalTitle = title;
    await saveState(state);
    res.json({ title });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/select", async (req, res) => {
  try {
    const state = await getState();
    const p = getProduct(state, req.body.id);
    if (!p) throw new Error("Product not found.");

    const title = safeName(req.body.title);
    if (!title) throw new Error("Enter a valid product title.");

    const imageUrl = new URL(String(req.body.imageUrl || ""));
    if (imageUrl.protocol !== "https:") throw new Error("Image URL must use HTTPS.");

    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Could not download the selected image.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) {
      throw new Error("Image is empty or larger than 15 MB.");
    }

    let filename = title + ".jpg";
    let destination = path.join(IMAGES, filename);
    let suffix = 2;
    while (true) {
      try {
        await fs.access(destination);
        filename = `${title} (${suffix++}).jpg`;
        destination = path.join(IMAGES, filename);
      } catch {
        break;
      }
    }

    await sharp(bytes)
      .resize(500, 500, { fit: "cover", position: "centre" })
      .jpeg({ quality: 90 })
      .toFile(destination);

    p.canonicalTitle = title;
    p.status = "selected";
    p.imagePath = path.relative(ROOT, destination).split(path.sep).join("/");
    await saveState(state);
    res.json({ filename });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/skip", async (req, res) => {
  const state = await getState();
  const p = getProduct(state, req.body.id);
  if (!p) return res.status(404).json({ error: "Product not found." });
  p.status = "skipped";
  await saveState(state);
  res.json({ success: true });
});

app.post("/api/export", async (req, res) => {
  const state = await getState();
  const selected = state.products.filter(product => product.status === "selected");
  const skipped = state.products.filter(product => product.status === "skipped");

  const productLines = selected.map(product =>
    `${product.canonicalTitle} - ${product.reseller} - ${product.retail}`
  );

  await fs.writeFile(path.join(OUTPUTS, "products.txt"), productLines.join("\n"));
  await fs.writeFile(path.join(OUTPUTS, "skipped.txt"), skipped.map(product => product.name).join("\n"));
  await fs.writeFile(path.join(OUTPUTS, "progress.json"), JSON.stringify(state, null, 2));
  res.json({ success: true, selected: selected.length, skipped: skipped.length });
});

app.get("/download/images.zip", async (req, res) => {
  const state = await getState();
  const selected = state.products.filter(product => product.status === "selected" && product.imagePath);
  const existing = [];

  for (const product of selected) {
    const filePath = path.resolve(ROOT, product.imagePath);
    if (!filePath.startsWith(IMAGES + path.sep)) continue;
    try {
      await fs.access(filePath);
      existing.push({ filePath, name: path.basename(filePath) });
    } catch { /* Ignore missing files rather than failing the whole ZIP. */ }
  }

  if (!existing.length) {
    return res.status(404).send("No selected images are available to download yet.");
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="perfume-images.zip"');
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", error => {
    if (!res.headersSent) res.status(500);
    res.end(error.message);
  });
  archive.pipe(res);
  for (const file of existing) archive.file(file.filePath, { name: file.name });
  archive.finalize();
});

app.get("/download/:file", async (req, res) => {
  const allowed = {
    "products.txt": "products.txt",
    "skipped.txt": "skipped.txt",
    "progress.json": "progress.json"
  };
  const file = allowed[req.params.file];
  if (!file) return res.sendStatus(404);
  try {
    await fs.access(path.join(OUTPUTS, file));
    res.download(path.join(OUTPUTS, file));
  } catch {
    res.status(404).send("Generate the output files first.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Perfume Image Tool running on port ${PORT}`);
});
