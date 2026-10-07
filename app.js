/* 万能手 —— 文章从 posts.json + posts/*.md 加载。
 * 写新文章请用「写文章」后台页面，或按 posts/ 下的格式手动添加。 */

let POSTS = [];

const views = {
  home: document.getElementById("view-home"),
  post: document.getElementById("view-post"),
  about: document.getElementById("view-about")
};
let activeCat = "全部";
let keyword = "";

function show(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
  window.scrollTo(0, 0);
}

function categories() {
  return ["全部", ...new Set(POSTS.map(p => p.category))];
}

function renderCats() {
  const box = document.getElementById("catFilters");
  if (!box) return;
  box.innerHTML = "";
  categories().forEach(c => {
    const b = document.createElement("button");
    b.className = "cat-btn" + (c === activeCat ? " active" : "");
    b.textContent = c;
    b.onclick = () => { activeCat = c; renderCats(); renderList(); };
    box.appendChild(b);
  });
}

function filtered() {
  return POSTS.filter(p => {
    const okCat = activeCat === "全部" || p.category === activeCat;
    const okKey = !keyword ||
      (p.title + p.excerpt + p.category).toLowerCase().includes(keyword.toLowerCase());
    return okCat && okKey;
  });
}

function renderList() {
  const list = document.getElementById("postList");
  const items = filtered();
  document.getElementById("emptyMsg").classList.toggle("hidden", items.length > 0);
  list.innerHTML = "";
  items.forEach(p => {
    const a = document.createElement("a");
    a.className = "post-card";
    a.innerHTML =
      '<h3 class="post-card-title">' + esc(p.title) + "</h3>" +
      '<p class="post-card-excerpt">' + esc(p.excerpt) + "</p>" +
      '<p class="post-card-date">' + esc(p.date) + "</p>";
    a.onclick = e => { e.preventDefault(); openPost(p); };
    list.appendChild(a);
  });
}

/* ---------- 极简 Markdown 渲染 ---------- */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy" style="max-width:100%;height:auto;border-radius:8px;display:block;margin:10px auto;">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  /* 裸链接自动变成可点击 */
  s = s.replace(/(^|[^\w/:="'%-])(https?:\/\/[^\s<>"')\]]+)/g, function(m, pre, url){
    let trail = "";
    const tm = url.match(/[。、，；：！？!?,;:'"')\].。、]+$/);
    if (tm) { trail = tm[0]; url = url.slice(0, -trail.length); }
    return pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>" + trail;
  });
  return s;
}

function mdToHtml(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  let html = "", inList = false, para = [];
  const flushPara = () => {
    if (para.length) { html += "<p>" + para.map(inlineMd).join("<br>") + "</p>"; para = []; }
  };
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      flushPara(); closeList();
      html += "<h" + m[1].length + ">" + inlineMd(m[2]) + "</h" + m[1].length + ">";
    } else if ((m = line.match(/^>\s?(.*)/))) {
      flushPara(); closeList();
      html += "<blockquote>" + inlineMd(m[1]) + "</blockquote>";
    } else if ((m = line.match(/^[-*]\s+(.*)/))) {
      flushPara();
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inlineMd(m[1]) + "</li>";
    } else if (/^---+$/.test(line.trim())) {
      flushPara(); closeList(); html += "<hr>";
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara(); closeList();
  return html;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  m[1].split("\n").forEach(l => {
    const i = l.indexOf(":");
    if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  });
  return { meta, body: m[2] };
}

async function openPost(p) {
  document.getElementById("postMeta").textContent = p.date;
  document.getElementById("postTitle").textContent = p.title;
  const bodyEl = document.getElementById("postBody");
  bodyEl.innerHTML = "<p>加载中…</p>";
  show("post");
  try {
    const res = await fetch("posts/" + p.file);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const { body } = parseFrontmatter(text);
    bodyEl.innerHTML =
      (p.demo ? '<p class="demo-note">这是示例文章，发布前记得替换成你自己的内容。</p>' : "") +
      mdToHtml(body);
  } catch (e) {
    bodyEl.innerHTML = "<p>文章加载失败，请稍后重试。</p>";
  }
}

/* ---------- 导航 / 搜索 / 主题 ---------- */

document.querySelectorAll("[data-nav]").forEach(el => {
  el.addEventListener("click", e => {
    e.preventDefault();
    show(el.dataset.nav);
  });
});

const searchBar = document.getElementById("searchBar");
const searchInput = document.getElementById("searchInput");
document.getElementById("searchToggle").onclick = () => {
  searchBar.classList.toggle("hidden");
  if (!searchBar.classList.contains("hidden")) searchInput.focus();
};
searchInput.oninput = () => { keyword = searchInput.value.trim(); renderList(); };

const themeBtn = document.getElementById("themeToggle");
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
  try { localStorage.setItem("blog-theme", t); } catch (e) {}
}
let saved = "light";
try { saved = localStorage.getItem("blog-theme") || "light"; } catch (e) {}
setTheme(saved);
themeBtn.onclick = () =>
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

document.getElementById("year").textContent = new Date().getFullYear();

/* ---------- 启动 ---------- */

fetch("posts.json")
  .then(r => r.json())
  .then(data => {
    POSTS = data;
    renderCats();
    renderList();
  })
  .catch(() => {
    document.getElementById("postList").innerHTML = "<p>文章列表加载失败。</p>";
  });
show("home");
