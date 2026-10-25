// Ported from .office-ref/src/index.tsx (the WebOffice prototype shell): the
// home screen, the four Craft editors loaded on first use and kept mounted,
// and the IndexedDB desk. Changes from the prototype: it is a component taking
// `appsBase` (where the editors are served) and `openOnStart` (files to fetch
// and open), with no createRoot — the /office route mounts it. SSR renders
// nothing: the shell opens IndexedDB and WebAssembly iframes, which only exist
// in a browser.
import React, { useEffect, useRef, useState } from "react";
import { download, files, saveFile, savedEntry, type SavedFile, type Tool } from "./library";
import { editorMessage } from "./bridge";
import "./office.css";

export type OpenOnStart = { name: string; url: string; tool: Tool };

const tools: { id: Tool; label: string; short: string; format: string; description: string; color: string; paper: string; bridge: boolean }[] = [
  { id: "wordcraft", label: "Documents", short: "Write", format: "DOCX", description: "Find the words. Make them yours.", color: "#315eac", paper: "#e5ebf5", bridge: true },
  { id: "gridcraft", label: "Spreadsheets", short: "Calculate", format: "XLSX", description: "A little order for your numbers.", color: "#34755b", paper: "#e5eee7", bridge: true },
  { id: "deckcraft", label: "Slides", short: "Present", format: "PPTX", description: "Give your next idea some space.", color: "#b65b36", paper: "#f6e8df", bridge: false },
  { id: "pdfcraft", label: "PDF", short: "Read & refine", format: "PDF", description: "The finishing touches, all here.", color: "#956046", paper: "#f0e7e1", bridge: true },
];
const getTool = (id: Tool) => tools.find((tool) => tool.id === id)!;
const bridgeTools = new Set<Tool>(["wordcraft", "gridcraft", "pdfcraft"]);

function ToolIcon({ tool, small = false }: { tool: Tool; small?: boolean }) {
  return (
    <svg className={small ? "tool-icon small" : "tool-icon"} viewBox="0 0 56 64" fill="none" aria-hidden="true">
      <path d="M9 2h27l13 13v45H9z" fill="currentColor" opacity=".1" />
      <path d="M9 2h27l13 13v45H9zM35 2v15h14" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      {tool === "wordcraft" && <path d="M18 28h22M18 36h22M18 44h15" stroke="currentColor" strokeWidth="2" />}
      {tool === "gridcraft" && <path d="M17 26h24v24H17zM17 34h24M17 42h24M25 26v24M33 26v24" stroke="currentColor" strokeWidth="1.5" />}
      {tool === "deckcraft" && (
        <>
          <path d="M17 27h24v19H17zM29 46v7M23 53h12" stroke="currentColor" strokeWidth="1.5" />
          <path d="m26 31 9 5-9 5z" fill="currentColor" />
        </>
      )}
      {tool === "pdfcraft" && (
        <>
          <path d="M18 48c11-4 19-12 16-21-4-6-6 17 9 17-5-7-20-5-25 4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M18 53h20" stroke="currentColor" />
        </>
      )}
    </svg>
  );
}

export function WebOffice({ appsBase, openOnStart = [] }: { appsBase: string; openOnStart?: OpenOnStart[] }) {
  const [active, setActive] = useState<Tool | "home">("home");
  const [opened, setOpened] = useState<Tool[]>([]);
  const [ready, setReady] = useState<Partial<Record<Tool, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Tool, string>>>({});
  const [zoom, setZoom] = useState<Partial<Record<Tool, number>>>({});
  const [attempts, setAttempts] = useState<Partial<Record<Tool, number>>>({});
  const [library, setLibrary] = useState<SavedFile[]>([]);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [help, setHelp] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [installPrompt, setInstallPrompt] = useState<(Event & { prompt: () => Promise<void> }) | null>(null);
  const [mount, setMount] = useState(false);
  const frames = useRef<Partial<Record<Tool, HTMLIFrameElement | null>>>({});
  const readyRef = useRef(new Set<Tool>());
  const dirty = useRef(new Set<Tool>());
  const saving = useRef(0);
  const currentFiles = useRef<Partial<Record<Tool, SavedFile>>>({});
  const pending = useRef<Partial<Record<Tool, SavedFile>>>({});
  const input = useRef<HTMLInputElement>(null);
  const about = useRef<HTMLDialogElement>(null);
  // openOnStart is consumed once per mount, through a ref so the message
  // handler and fetches below read it without re-running on prop changes.
  const startList = useRef(openOnStart);
  startList.current = openOnStart;

  // The prototype's beforeunload protection opens a confirm dialog on every
  // navigation in the host app, where unsaved editor state is not known at
  // that point; the desk's Save/Download buttons are the way out here.
  useEffect(() => {
    setMount(true);
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current.size || saving.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);

  useEffect(() => {
    const dialog = about.current;
    if (!help || !dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [help]);

  async function refreshLibrary() {
    try {
      setLibrary(await files());
    } catch {
      setNotice("Browser storage is unavailable. Use each editor’s Save to download your work.");
    }
  }

  useEffect(() => {
    if (!mount) return;
    void refreshLibrary();
  }, [mount]);

  function sendFile(tool: Tool, file: SavedFile) {
    const frame = frames.current[tool];
    if (!frame?.contentWindow || !readyRef.current.has(tool)) {
      pending.current[tool] = file;
      return;
    }
    currentFiles.current[tool] = file;
    frame.contentWindow.postMessage({ type: `${tool}:open`, name: file.name, bytes: file.bytes.slice(0) }, location.origin);
    delete pending.current[tool];
  }

  useEffect(() => {
    const message = async (event: MessageEvent) => {
      const tool = editorMessage(event, location.origin, frames.current);
      if (!tool) return;
      const { type, name, bytes } = event.data;
      if (type === `${tool}:ready`) {
        readyRef.current.add(tool);
        setReady((previous) => ({ ...previous, [tool]: true }));
        if (pending.current[tool]) sendFile(tool, pending.current[tool]!);
      } else if (type === `${tool}:dirty`) {
        if (event.data.dirty) dirty.current.add(tool);
        else dirty.current.delete(tool);
      } else if (type === `${tool}:failed`) {
        setNotice(`${getTool(tool).label}: ${String(event.data.error || "The file could not be opened.")}`);
      } else if (type === `${tool}:save` && typeof name === "string" && bytes instanceof ArrayBuffer) {
        const { file, updatesCurrent } = savedEntry(tool, { name, bytes, saveAs: event.data.saveAs }, currentFiles.current[tool]);
        // Protect workbook saves until commit; exports leave the workbook's dirty state alone.
        if (updatesCurrent) dirty.current.add(tool);
        saving.current += 1;
        try {
          await saveFile(file);
          if (updatesCurrent) {
            currentFiles.current[tool] = file;
            dirty.current.delete(tool);
          }
          await refreshLibrary();
          setNotice(`Saved ${name} on this device. Download a copy to keep it outside your browser.`);
        } catch {
          download(file);
          setNotice(`Browser storage could not save ${name}. A backup download has been started; check your Downloads.`);
        } finally {
          saving.current -= 1;
        }
      }
    };
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, []);

  function launch(tool: Tool) {
    setActive(tool);
    setOpened((previous) => (previous.includes(tool) ? previous : [...previous, tool]));
    setNotice("");
    void fetch(`${appsBase}/${tool}/index.html`).then((response) => {
      if (!response.ok) throw new Error(`Editor files are missing (${response.status}). Run npm run prepare:office, then build the site again.`);
    }).catch((error) => setErrors((previous) => ({ ...previous, [tool]: String(error.message) })));
  }

  async function openSaved(file: SavedFile) {
    if (dirty.current.has(file.tool) && !window.confirm("Open another file in this editor? Download or save your current changes first.")) return;
    launch(file.tool);
    sendFile(file.tool, file);
  }

  async function importFile(file: File) {
    const extension = file.name.split(".").pop()?.toLowerCase();
    const tool = extension === "pdf" ? "pdfcraft" : ["xlsx", "xlsm", "csv", "tsv", "ods"].includes(extension || "") ? "gridcraft" : ["pptx", "odp"].includes(extension || "") ? "deckcraft" : "wordcraft";
    if (!bridgeTools.has(tool)) {
      launch(tool);
      setNotice(`Use File → Open inside ${getTool(tool).label} to select ${file.name}. This editor saves to your Downloads folder.`);
      return;
    }
    if (dirty.current.has(tool) && !window.confirm("Open another file in this editor? Save your current changes first.")) return;
    try {
      const saved: SavedFile = { id: crypto.randomUUID(), name: file.name, tool, bytes: await file.arrayBuffer(), modified: Date.now() };
      await saveFile(saved);
      await refreshLibrary();
      launch(tool);
      sendFile(tool, saved);
    } catch {
      setNotice("This file could not be stored. Try File → Open inside the editor.");
    }
  }

  // Fetch each openOnStart file once the shell is in the browser, add it to
  // the desk, then open it in its editor. A missing file (404) is expected:
  // the findings are only sometimes published, so they just do not appear.
  useEffect(() => {
    if (!mount || startList.current.length === 0) return;
    const list = startList.current;
    startList.current = [];
    void (async () => {
      const absent: string[] = [];
      const noBridge: string[] = [];
      for (const item of list) {
        try {
          const response = await fetch(item.url);
          if (response.status === 404) {
            absent.push(item.name);
            continue;
          }
          if (!response.ok) continue;
          const saved: SavedFile = { id: crypto.randomUUID(), name: item.name, tool: item.tool, bytes: await response.arrayBuffer(), modified: Date.now() };
          await saveFile(saved);
          await refreshLibrary();
          // An editor without the parent bridge (Slides) cannot be handed a file: keep it on the desk and
          // say how to open it, instead of launching an empty editor.
          if (!bridgeTools.has(item.tool)) {
            noBridge.push(item.name);
            continue;
          }
          launch(item.tool);
          sendFile(item.tool, saved);
        } catch {
          // No network or a failed fetch: leave the desk as it is.
        }
      }
      if (absent.length) setMissing(absent);
      if (noBridge.length) setNotice(`${noBridge.join(", ")} is on your desk: download it from Home, then use File → Open in Slides.`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mount]);

  const visibleFiles = library.filter((file) => file.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className={`webOffice workspace ${active === "home" ? "at-home" : "in-editor"}`} style={{ display: mount ? undefined : "none" }}>
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <header className="topbar">
        <div className="topbar-right">
          <span className="local-label"><span className="status-dot" />Your work stays here</span>
          <button className="help-button" onClick={() => setHelp(true)} aria-label="About this workspace">?</button>
        </div>
      </header>
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="sidebar-top">
          <span className="nav-caption">YOUR WORKSPACE</span>
          <button aria-label="Home" title="Home" aria-current={active === "home" ? "page" : undefined} className={`nav-item home-nav ${active === "home" ? "selected" : ""}`} onClick={() => setActive("home")}>
            <span aria-hidden="true">⌂</span>
            <span>Home</span>
          </button>
          <div className="nav-divider" />
          <span className="nav-caption">MAKE SOMETHING</span>
          {tools.map((tool) => (
            <button key={tool.id} aria-label={tool.label} aria-current={active === tool.id ? "page" : undefined} title={tool.label} className={`nav-item ${active === tool.id ? "selected" : ""}`} style={{ "--tool-color": tool.color } as React.CSSProperties} onClick={() => launch(tool.id)}>
              <ToolIcon tool={tool.id} small />
              <span>{tool.label}</span>
              {opened.includes(tool.id) && <span className="session-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <p>One workspace.<br />Four tools.</p>
          <span>Work directly in your browser.</span>
          {installPrompt && (
            <button className="install-button" onClick={async () => { await installPrompt.prompt(); setInstallPrompt(null); }}>
              Add to home screen ↗
            </button>
          )}
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button aria-label="Dismiss notification" onClick={() => setNotice("")}>×</button>
          </div>
        )}
        <section hidden={active !== "home"} className="home-view">
          <div className="home-heading">
            <div>
              <p className="eyebrow">WEB OFFICE</p>
              <h1>Your workspace.</h1>
              <p className="intro">Create a document, work with numbers, build a presentation or open a PDF.</p>
            </div>
          </div>
          <div className="tool-grid">
            {tools.map((tool, index) => (
              <button className="tool-card" key={tool.id} onClick={() => launch(tool.id)} style={{ "--tool-color": tool.color, "--tool-paper": tool.paper, "--delay": `${index * 45}ms` } as React.CSSProperties}>
                <div className="card-top"><span className="tool-number">0{index + 1}</span><span className="format">{tool.format}</span></div>
                <div className="paper-preview"><ToolIcon tool={tool.id} /><span className={`paper-decoration decoration-${tool.id}`} /></div>
                <h2>{tool.label}</h2>
                <p>{tool.description}</p>
                <span className="card-action">{opened.includes(tool.id) ? "Continue working" : tool.short}<span aria-hidden="true">↗</span></span>
              </button>
            ))}
          </div>
          <section className="library-section" aria-labelledby="library-title">
            <div className="section-heading">
              <div>
                <h2 id="library-title">On your desk <span>{library.length.toString().padStart(2, "0")}</span></h2>
                <p>Spreadsheets and PDFs you open or save here.</p>
              </div>
              <button className="open-file" onClick={() => input.current?.click()}>
                <span aria-hidden="true">＋</span> Open a file
              </button>
            </div>
            <input ref={input} className="visually-hidden" type="file" accept=".docx,.odt,.rtf,.txt,.md,.xlsx,.xlsm,.ods,.csv,.tsv,.pptx,.odp,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} />
            {library.length > 0 && (
              <label className="search-label">
                <span>Find a file</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your desk…" />
              </label>
            )}
            {library.length === 0 ? (
              <div className="empty-desk">
                <div className="empty-paper" aria-hidden="true"><span /><span /><span /></div>
                <div>
                  <h3>Good work starts with a little space.</h3>
                  <p>Open a spreadsheet or PDF, or start something above.<br />Documents and slides use their editor’s file menu.</p>
                </div>
              </div>
            ) : (
              <div className="file-list">
                {visibleFiles.map((file) => (
                  <div className="file-row" key={file.id}>
                    <button onClick={() => void openSaved(file)} className="file-open">
                      <span style={{ color: getTool(file.tool).color }}><ToolIcon tool={file.tool} small /></span>
                      <span><strong>{file.name}</strong><small>{getTool(file.tool).label} · {new Date(file.modified).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</small></span>
                    </button>
                    <button className="download-button" onClick={() => download(file)} aria-label={`Download ${file.name}`}>
                      Download <span aria-hidden="true">↓</span>
                    </button>
                  </div>
                ))}
                {visibleFiles.length === 0 && <p className="no-results">No files match “{query}”.</p>}
              </div>
            )}
          </section>
          <footer className="home-footer">
            <span><span className="status-dot" />In your browser. On your terms.</span>
            <button onClick={() => setHelp(true)}>Built with the Craft apps <span aria-hidden="true">↗</span></button>
          </footer>
          {missing.length > 0 && (
            <p className="not-published" role="status">
              Not published yet: {missing.join(", ")} {missing.length === 1 ? "is" : "are"} not on the server. This page will show them once they are published.
            </p>
          )}
        </section>
        {active !== "home" && (
          <div className="editor-toolbar">
            <div>
              <span className="status-dot" />
              <strong>{getTool(active).label}</strong>
              <span className="editor-subtitle">{getTool(active).bridge ? "Save to your desk · Download a copy from Home" : "Open and save with the File menu"}</span>
            </div>
            <div className="editor-options">
              <label className="editor-size">
                <span>Editor size</span>
                <select value={zoom[active] || 1} onChange={(event) => setZoom((previous) => ({ ...previous, [active]: Number(event.target.value) }))}>
                  {[1, 1.25, 1.5, 1.75, 2].map((scale) => (
                    <option key={scale} value={scale}>{scale * 100}%</option>
                  ))}
                </select>
              </label>
              <button onClick={() => setActive("home")}>Back to desk <span aria-hidden="true">↗</span></button>
            </div>
          </div>
        )}
        <div className="editors" hidden={active === "home"}>
          {opened.map((tool) => (
            <section key={tool} hidden={active !== tool} className="editor-panel" style={{ "--editor-scale": zoom[tool] || 1 } as React.CSSProperties} aria-label={`${getTool(tool).label} editor`}>
              {!ready[tool] && !errors[tool] && (
                <div className="loading-editor" role="status">
                  <span className="loading-spinner" aria-hidden="true" />
                  <h2>Opening {getTool(tool).label.toLowerCase()}…</h2>
                  <p>The first visit takes a moment. Your editor runs on this device.</p>
                </div>
              )}
              {errors[tool] ? (
                <div className="loading-editor" role="alert">
                  <h2>The editor couldn’t load.</h2>
                  <p>{errors[tool]}</p>
                  <button className="open-file" onClick={() => { setErrors((previous) => ({ ...previous, [tool]: undefined })); setReady((previous) => ({ ...previous, [tool]: false })); readyRef.current.delete(tool); setAttempts((previous) => ({ ...previous, [tool]: (previous[tool] || 0) + 1 })); launch(tool); }}>
                    Try this editor again
                  </button>
                </div>
              ) : (
                <iframe
                  key={`${tool}-${attempts[tool] || 0}`}
                  ref={(element) => { frames.current[tool] = element; }}
                  src={`${appsBase}/${tool}/?${getTool(tool).bridge ? "host=parent&" : ""}${tool === "deckcraft" ? "blank&" : ""}webgl`}
                  title={`${getTool(tool).label} — ${tool}`}
                  allow="clipboard-read; clipboard-write; fullscreen"
                  onLoad={(event) => {
                    const frame = event.currentTarget;
                    const check = () => {
                      try {
                        const document = frame.contentDocument;
                        if (document?.querySelector("canvas") && !document.querySelector(`[id="${tool}_loading"]`)) {
                          if (!getTool(tool).bridge) setReady((previous) => ({ ...previous, [tool]: true }));
                          return;
                        }
                        const failure = document?.querySelector(`[id="${tool}_loading"]`)?.textContent;
                        if (failure && /error|failed|crash/i.test(failure)) {
                          setErrors((previous) => ({ ...previous, [tool]: failure }));
                          return;
                        }
                      } catch {
                        /* Same-origin assets are required. */
                      }
                      if (frame.isConnected) window.setTimeout(check, 500);
                    };
                    check();
                  }}
                />
              )}
            </section>
          ))}
        </div>
      </main>
      {help && (
        <dialog ref={about} className="about-dialog" aria-labelledby="about-title" onClose={() => setHelp(false)} onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setHelp(false);
        }}>
          <button className="modal-close" onClick={() => setHelp(false)} aria-label="Close about" autoFocus>×</button>
          <p className="eyebrow">ONE PLACE TO MAKE THINGS</p>
          <h2 id="about-title">Meet your WebOffice.</h2>
          <p>Four real Craft editors, together in one browser workspace. Editors load when you open them and stay open as you switch tools.</p>
          <p>Spreadsheets and PDFs can save to your desk in this browser. Documents and slides use their own File menu and save as downloads. Download important files: clearing browser data also clears your desk.</p>
          <p>This workspace needs the PRISM server that serves it to load the editors. A home-screen shortcut does not yet make them available offline. A keyboard and mouse can help with the desktop-style editing controls.</p>
          <p>Independent prototype using the open-source <a href="https://github.com/storytold" target="_blank" rel="noreferrer">Craft apps</a>. Not an official ArtCraft product.</p>
          <button className="open-file" onClick={() => setHelp(false)}>Make yourself at home ↗</button>
        </dialog>
      )}
    </div>
  );
}
