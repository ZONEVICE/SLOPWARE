/* Frisbee uses independent workspace, preview, transfer, and notepad state.
 * Keep server requests in api() and build untrusted names with textContent.
 * A workspace operation never disables the application navigation or notepad.
 */
(function () {
  "use strict";

  var byId = function (id) { return document.getElementById(id); };
  var state = {
    workspace: null,
    path: "",
    entries: [],
    searchQuery: "",
    showPreviews: false,
    hideHiddenFolders: true,
    selected: new Set(),
    busy: false,
    file: null,
    fileDirty: false,
    fileSaving: false,
    note: { name: "", revision: null, isNew: true },
    noteDirty: false,
    noteBusy: false,
    notesLoaded: false,
    noteRequest: 0,
    destination: "",
    destinationRequest: 0,
    transfer: null
  };

  function listen(id, event, callback) {
    byId(id).addEventListener(event, function (ev) {
      try { Promise.resolve(callback(ev)).catch(reportError); }
      catch (error) { reportError(error); }
    });
  }

  function notify(message, kind) {
    var notice = byId("notice");
    notice.textContent = message;
    notice.dataset.kind = kind || "info";
    notice.hidden = !message;
  }

  function reportError(error) {
    notify(error && error.message ? error.message : String(error), "error");
  }

  function apiUrl(endpoint, values) {
    var params = new URLSearchParams();
    Object.keys(values || {}).forEach(function (key) {
      if (values[key] !== undefined && values[key] !== null) { params.set(key, values[key]); }
    });
    return endpoint + (params.toString() ? "?" + params.toString() : "");
  }

  function workspaceUrl(endpoint, path) {
    return apiUrl(endpoint, { workspace: state.workspace.id, path: path });
  }

  async function api(endpoint, method, body) {
    var options = { method: method || "GET", cache: "no-store" };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    var response;
    try { response = await fetch(endpoint, options); }
    catch (error) { throw new Error("Cannot reach Frisbee. Check the connection to the host computer."); }
    var data;
    try { data = await response.json(); }
    catch (error) { throw new Error("The server returned an unreadable response (HTTP " + response.status + ")."); }
    if (!response.ok) {
      var failure = new Error(data.error || "Request failed (HTTP " + response.status + ").");
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  function bytes(value) {
    if (value === null || value === undefined) { return "—"; }
    var units = ["B", "KB", "MB", "GB", "TB"];
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return (unit ? value.toFixed(1) : value) + " " + units[unit];
  }

  function dateLabel(value) {
    if (value === null || value === undefined) { return "Unavailable"; }
    var date = new Date(value * 1000);
    return isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
  }

  function parentPath(path) {
    var slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
  }

  function relativePath(path) {
    return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  function makeButton(label, action, className) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (className) { button.className = className; }
    button.addEventListener("click", function () {
      try { Promise.resolve(action()).catch(reportError); }
      catch (error) { reportError(error); }
    });
    return button;
  }

  function setWorkspaceBusy(busy) {
    state.busy = busy;
    document.querySelectorAll("[data-workspace-action]").forEach(function (control) {
      control.disabled = busy;
    });
    byId("open-workspace").disabled = busy;
    document.querySelectorAll(".entry-checkbox").forEach(function (control) { control.disabled = busy; });
    updateSelection();
  }

  /* Keep the complete server listing intact. Filters are local to that listing,
   * and only visible paths may remain selected for a later bulk operation.
   * Dot-prefixed files stay visible; the hidden-folder option applies to folders.
   */
  function visibleEntries() {
    var query = state.searchQuery.toLowerCase();
    return state.entries.filter(function (entry) {
      return !(state.hideHiddenFolders && entry.kind === "directory" && entry.name.charAt(0) === ".") &&
        (!query || entry.name.toLowerCase().indexOf(query) !== -1);
    });
  }

  function pruneSelection(entries) {
    var visiblePaths = new Set(entries.map(function (entry) { return entry.path; }));
    state.selected.forEach(function (path) {
      if (!visiblePaths.has(path)) { state.selected.delete(path); }
    });
  }

  function resetDirectorySearch() {
    state.searchQuery = "";
    byId("directory-search").value = "";
  }

  function updateSelection() {
    var entries = visibleEntries();
    pruneSelection(entries);
    var count = state.selected.size;
    byId("selection-count").textContent = count + " selected";
    document.querySelectorAll("[data-selection-action]").forEach(function (control) {
      control.disabled = state.busy || !count;
    });
    byId("select-all").disabled = state.busy || !entries.length;
    byId("select-all").checked = !!entries.length && count === entries.length;
    byId("select-all").indeterminate = count > 0 && count < entries.length;
  }

  function canLeaveFile() {
    if (state.fileSaving) { return false; }
    return !state.fileDirty || window.confirm("Discard unsaved changes to this file?");
  }

  function showMain(view) {
    if (view !== "workspace") { byId("preview-video").pause(); }
    byId("workspace-view").hidden = view !== "workspace";
    byId("notepad-view").hidden = view !== "notepad";
    byId("workspace-tab").setAttribute("aria-pressed", String(view === "workspace"));
    byId("notepad-tab").setAttribute("aria-pressed", String(view === "notepad"));
  }

  function renderBreadcrumbs(path, fileName) {
    var container = byId("breadcrumbs");
    container.replaceChildren();
    var segments = path ? path.split("/") : [];
    var root = makeButton("Root", function () { return openDirectory(""); });
    root.setAttribute("data-workspace-action", "");
    root.disabled = state.busy;
    container.appendChild(root);
    var current = "";
    segments.forEach(function (segment) {
      current = current ? current + "/" + segment : segment;
      var target = current;
      var separator = document.createElement("span");
      separator.textContent = "/";
      separator.setAttribute("aria-hidden", "true");
      container.appendChild(separator);
      var button = makeButton(segment, function () { return openDirectory(target); });
      button.setAttribute("data-workspace-action", "");
      button.disabled = state.busy;
      container.appendChild(button);
    });
    if (fileName) {
      var name = document.createElement("span");
      name.textContent = "/ " + fileName;
      name.setAttribute("aria-current", "page");
      container.appendChild(name);
    } else {
      container.lastElementChild.setAttribute("aria-current", "page");
    }
  }

  /* Detaching a video alone does not reliably stop network activity or audio.
   * Explicitly pause and remove each source before replacing or hiding a view.
   * Calling load() after removing the source releases the media resource; it
   * does not request a replacement file.
   */
  function releaseMedia(container) {
    container.querySelectorAll("img, video").forEach(function (media) {
      var hadSource = media.hasAttribute("src");
      if (media.tagName === "VIDEO") { media.pause(); }
      media.removeAttribute("src");
      if (media.tagName === "VIDEO" && hadSource) { media.load(); }
    });
  }

  function makeMediaThumbnail(entry) {
    var button = makeButton("", function () { return openFile(entry); }, "media-thumbnail-button");
    button.setAttribute("aria-label", "Preview " + entry.name);
    button.setAttribute("data-workspace-action", "");
    button.disabled = state.busy;
    var media = document.createElement(entry.preview === "video" ? "video" : "img");
    media.className = "media-thumbnail";
    media.setAttribute("aria-hidden", "true");
    if (entry.preview === "video") {
      media.preload = "metadata";
      media.muted = true;
      media.defaultMuted = true;
      media.playsInline = true;
      media.tabIndex = -1;
      media.addEventListener("loadedmetadata", function () {
        if (!media.hasAttribute("src") || !media.isConnected) { return; }
        // Some browsers load metadata without a frame. A tiny seek asks for
        // the opening frame while the thumbnail remains paused and muted.
        if (media.readyState < 2 && isFinite(media.duration) && media.duration > 0) {
          try { media.currentTime = Math.min(0.1, media.duration / 2); }
          catch (error) { /* The filename still opens the full preview. */ }
        }
      });
      media.addEventListener("play", function () { media.pause(); });
    } else {
      media.alt = "";
      media.loading = "lazy";
      media.decoding = "async";
    }
    var fallback = document.createElement("span");
    fallback.className = "media-preview-fallback";
    fallback.textContent = "Preview unavailable";
    fallback.hidden = true;
    media.addEventListener("error", function () {
      if (!media.hasAttribute("src")) { return; }
      media.hidden = true;
      fallback.hidden = false;
    });
    // This function is called only when previews are enabled, so the default
    // directory listing never starts image or video requests.
    media.src = workspaceUrl("/api/preview", entry.path);
    button.append(media, fallback);
    return button;
  }

  function renderEntries() {
    var body = byId("file-list");
    releaseMedia(body);
    body.replaceChildren();
    var fragment = document.createDocumentFragment();
    var entries = visibleEntries();
    pruneSelection(entries);
    entries.forEach(function (entry) {
      var row = document.createElement("tr");
      function cell(label, value) {
        var td = document.createElement("td");
        td.dataset.label = label;
        if (value !== undefined) { td.textContent = value; }
        row.appendChild(td);
        return td;
      }
      var selection = cell("Select");
      selection.className = "selection-cell";
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "entry-checkbox";
      checkbox.disabled = state.busy;
      checkbox.setAttribute("aria-label", "Select " + entry.name);
      checkbox.checked = state.selected.has(entry.path);
      checkbox.addEventListener("change", function () {
        if (checkbox.checked) { state.selected.add(entry.path); }
        else { state.selected.delete(entry.path); }
        updateSelection();
      });
      selection.appendChild(checkbox);
      var name = cell("Name");
      var nameRow = document.createElement("div");
      nameRow.className = "entry-name-row";
      var nameText = document.createElement("div");
      nameText.className = "entry-name-text";
      if (state.showPreviews && entry.kind === "file" && (entry.preview === "image" || entry.preview === "video")) {
        nameRow.appendChild(makeMediaThumbnail(entry));
      }
      nameRow.appendChild(nameText);
      name.appendChild(nameRow);
      var button = makeButton(entry.name, function () {
        return entry.kind === "directory" ? openDirectory(entry.path) : openFile(entry);
      }, "link-button");
      button.setAttribute("data-workspace-action", "");
      button.disabled = state.busy;
      nameText.appendChild(button);
      var kind = document.createElement("span");
      kind.className = "entry-kind";
      kind.textContent = entry.kind === "directory" ? "Folder" : (entry.kind === "other" ? "Special file" : "File");
      if (entry.is_link) { kind.textContent += " · Symbolic link"; }
      if (entry.readable === false) { kind.textContent += " · Not readable"; }
      nameText.appendChild(kind);
      cell("Size", bytes(entry.size));
      cell("Created", dateLabel(entry.created));
      cell("Files inside", entry.kind === "directory" ? (entry.file_count === null || entry.file_count === undefined ? "Unavailable" : String(entry.file_count)) : "—");
      var actions = document.createElement("div");
      actions.className = "row-actions";
      var rename = makeButton("Rename", function () { return renameEntry(entry); });
      rename.setAttribute("data-workspace-action", "");
      rename.disabled = state.busy;
      rename.setAttribute("aria-label", "Rename " + entry.name);
      var remove = makeButton("Delete", function () { return deleteEntries([entry.path]); });
      remove.setAttribute("data-workspace-action", "");
      remove.disabled = state.busy;
      remove.setAttribute("aria-label", "Delete " + entry.name);
      actions.append(rename, remove);
      cell("Actions").appendChild(actions);
      fragment.appendChild(row);
    });
    body.appendChild(fragment);
    byId("empty-directory").hidden = !!entries.length;
    byId("empty-directory").textContent = state.entries.length ? "No items match the current filters." : "This directory is empty.";
    byId("directory-summary").textContent = entries.length + (entries.length === state.entries.length ? "" : " of " + state.entries.length) +
      (state.entries.length === 1 ? " item" : " items") + " · Folder counts include direct files.";
    updateSelection();
  }

  async function openDirectory(path) {
    if (state.busy || !state.workspace || !canLeaveFile()) { return; }
    byId("preview-video").pause();
    setWorkspaceBusy(true);
    try {
      var data = await api(workspaceUrl("/api/files", path));
      // Failed navigation keeps the current search, as do refresh and returning
      // from a file preview to the same directory.
      if (data.path !== state.path) { resetDirectorySearch(); }
      releaseMedia(byId("file-view"));
      state.path = data.path;
      state.entries = data.entries;
      state.selected.clear();
      state.file = null;
      state.fileDirty = false;
      byId("directory-view").hidden = false;
      byId("file-view").hidden = true;
      byId("move-panel").hidden = true;
      renderBreadcrumbs(state.path);
      renderEntries();
    } finally { setWorkspaceBusy(false); }
  }

  async function chooseWorkspace(event) {
    event.preventDefault();
    if (state.busy) { return; }
    var mode = document.querySelector('input[name="workspace-mode"]:checked').value;
    var path = byId("absolute-path").value.trim();
    if (mode === "absolute" && !path) { byId("absolute-path").reportValidity(); return; }
    notify("");
    setWorkspaceBusy(true);
    try {
      var data = await api("/api/workspaces", "POST", { mode: mode, path: path });
      releaseMedia(byId("file-view"));
      resetDirectorySearch();
      state.workspace = data.workspace;
      state.path = "";
      state.entries = [];
      state.selected.clear();
      byId("workspace-root").textContent = data.workspace.root;
      byId("workspace-form").hidden = true;
      byId("workspace-content").hidden = false;
      byId("directory-view").hidden = false;
      byId("file-view").hidden = true;
      byId("change-workspace").hidden = false;
      renderBreadcrumbs("");
      renderEntries();
      try { localStorage.setItem("frisbee.absolutePath", path); } catch (error) { /* Storage is optional. */ }
    } finally { setWorkspaceBusy(false); }
    await openDirectory("");
  }

  function changeWorkspace() {
    if (state.busy || !canLeaveFile()) { return; }
    releaseMedia(byId("file-view"));
    releaseMedia(byId("file-list"));
    state.workspace = null;
    state.file = null;
    state.fileDirty = false;
    state.selected.clear();
    byId("workspace-content").hidden = true;
    byId("workspace-form").hidden = false;
    byId("change-workspace").hidden = true;
    byId("open-workspace").focus();
    notify("");
  }

  async function renameEntry(entry) {
    if (state.busy) { return; }
    var name = window.prompt("New name for " + entry.name + ":", entry.name);
    if (name === null || name === entry.name) { return; }
    if (!name) { throw new Error("Enter a name."); }
    setWorkspaceBusy(true);
    try {
      await api("/api/rename", "POST", { workspace: state.workspace.id, path: entry.path, name: name });
      notify("Renamed " + entry.name + " to " + name + ".");
    } finally { setWorkspaceBusy(false); }
    await openDirectory(state.path);
  }

  async function deleteEntries(paths) {
    if (state.busy || !paths.length) { return; }
    var description = paths.length === 1 ? '"' + paths[0] + '"' : paths.length + " selected items";
    if (!window.confirm("Delete " + description + "? Folders and their contents will be permanently removed.")) { return; }
    setWorkspaceBusy(true);
    var data;
    try {
      data = await api("/api/delete", "POST", { workspace: state.workspace.id, paths: paths });
    } finally { setWorkspaceBusy(false); }
    await openDirectory(state.path);
    var errors = data.errors || [];
    var count = Array.isArray(data.deleted) ? data.deleted.length : data.deleted;
    notify("Deleted " + count + " item(s)." + (errors.length ? "\n" + errors.join("\n") : ""), errors.length ? "error" : "info");
  }

  async function createDirectory() {
    if (state.busy) { return; }
    var name = window.prompt("New folder name:");
    if (name === null) { return; }
    if (!name) { throw new Error("Enter a folder name."); }
    setWorkspaceBusy(true);
    try {
      await api("/api/directories", "POST", { workspace: state.workspace.id, path: state.path, name: name });
    } finally { setWorkspaceBusy(false); }
    await openDirectory(state.path);
    notify("Created folder " + name + ".");
  }

  function startDownload(url) {
    var link = document.createElement("a");
    link.href = url;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function downloadSelection() {
    if (state.busy || !state.selected.size) { return; }
    setWorkspaceBusy(true);
    notify("Preparing ZIP download...");
    try {
      var data = await api("/api/archives", "POST", { workspace: state.workspace.id, paths: Array.from(state.selected) });
      startDownload(data.download_url);
      notify("ZIP download started.");
    } finally { setWorkspaceBusy(false); }
  }

  /* Preview state is preserved while the user visits the notepad. Editing only
   * starts on an explicit click; revisions prevent unnoticed concurrent writes.
   */
  async function openFile(entry) {
    if (state.busy || !canLeaveFile()) { return; }
    releaseMedia(byId("file-list"));
    releaseMedia(byId("file-view"));
    state.file = { entry: entry, content: "", revision: null };
    state.fileDirty = false;
    byId("file-heading").textContent = entry.name;
    byId("file-details").textContent = bytes(entry.size) + " · Created: " + dateLabel(entry.created);
    byId("download-file").href = workspaceUrl("/api/download", entry.path);
    byId("directory-view").hidden = true;
    byId("file-view").hidden = false;
    byId("text-preview").hidden = true;
    byId("image-preview").hidden = true;
    byId("video-preview").hidden = true;
    byId("binary-preview").hidden = true;
    byId("preview-status").hidden = true;
    renderBreadcrumbs(state.path, entry.name);
    notify("");
    if (entry.preview === "image") {
      byId("image-preview").hidden = false;
      byId("preview-image").alt = entry.name;
      byId("preview-image").src = workspaceUrl("/api/preview", entry.path);
    } else if (entry.preview === "video") {
      byId("video-preview").hidden = false;
      byId("preview-video").setAttribute("aria-label", entry.name);
      byId("preview-video").src = workspaceUrl("/api/preview", entry.path);
    } else if (entry.preview === "text") {
      setWorkspaceBusy(true);
      byId("preview-status").textContent = "Loading text...";
      byId("preview-status").hidden = false;
      try {
        var data = await api(workspaceUrl("/api/content", entry.path));
        state.file.content = data.content;
        state.file.revision = data.revision;
        byId("file-editor").value = data.content;
        byId("file-editor").readOnly = true;
        byId("text-preview").hidden = false;
        byId("edit-file").hidden = false;
        byId("discard-file").hidden = true;
        updateFileDirty(false);
        byId("preview-status").hidden = true;
      } catch (error) {
        byId("preview-status").textContent = error.message + " You can still download this file.";
      } finally { setWorkspaceBusy(false); }
    } else {
      byId("binary-preview").hidden = false;
    }
  }

  function updateFileDirty(dirty) {
    state.fileDirty = dirty;
    byId("save-file").disabled = !dirty || state.fileSaving;
    byId("file-edit-status").textContent = state.fileSaving ? "Saving..." : (dirty ? "Unsaved changes" : (byId("file-editor").readOnly ? "Read only" : "No unsaved changes"));
  }

  async function saveFile() {
    if (!state.file || !state.fileDirty || state.fileSaving) { return; }
    var content = byId("file-editor").value;
    state.fileSaving = true;
    byId("file-editor").readOnly = true;
    byId("discard-file").disabled = true;
    updateFileDirty(true);
    try {
      var data = await api("/api/content", "PUT", {
        workspace: state.workspace.id,
        path: state.file.entry.path,
        content: content,
        revision: state.file.revision
      });
      state.file.content = content;
      state.file.revision = data.revision;
      state.fileDirty = false;
      notify("File saved.");
    } finally {
      state.fileSaving = false;
      byId("file-editor").readOnly = false;
      byId("discard-file").disabled = false;
      updateFileDirty(state.fileDirty);
    }
  }

  function discardFile() {
    if (!state.file || state.fileSaving || (state.fileDirty && !window.confirm("Discard unsaved changes to this file?"))) { return; }
    byId("file-editor").value = state.file.content;
    byId("file-editor").readOnly = true;
    byId("edit-file").hidden = false;
    byId("discard-file").hidden = true;
    updateFileDirty(false);
  }

  function openMovePanel() {
    if (state.busy || !state.selected.size) { return; }
    byId("move-panel").hidden = false;
    byId("destination-browser").hidden = true;
    byId("move-destination").value = state.path || "/";
    byId("move-destination").focus();
  }

  async function browseDestination(path) {
    var request = ++state.destinationRequest;
    var workspaceId = state.workspace.id;
    byId("destination-browser").hidden = false;
    byId("destination-current").textContent = "Loading...";
    byId("destination-list").replaceChildren();
    byId("destination-choose").disabled = true;
    var data = await api(apiUrl("/api/files", { workspace: workspaceId, path: path }));
    if (request !== state.destinationRequest || !state.workspace || state.workspace.id !== workspaceId) { return; }
    state.destination = data.path;
    byId("destination-current").textContent = "/" + data.path;
    byId("destination-parent").disabled = !data.path;
    byId("destination-choose").disabled = false;
    var dirs = data.entries.filter(function (entry) { return entry.kind === "directory"; });
    dirs.forEach(function (entry) {
      var li = document.createElement("li");
      li.appendChild(makeButton(entry.name, function () { return browseDestination(entry.path); }));
      byId("destination-list").appendChild(li);
    });
    if (!dirs.length) {
      var empty = document.createElement("li");
      empty.textContent = "No subdirectories.";
      byId("destination-list").appendChild(empty);
    }
  }

  function beginTransfer(kind) {
    state.transfer = { kind: kind, cancelled: false, xhr: null };
    byId("transfer-panel").hidden = false;
    byId("transfer-heading").textContent = kind === "move" ? "Moving items" : "Uploading items";
    byId("transfer-errors").replaceChildren();
    byId("transfer-progress").value = 0;
    byId("transfer-message").textContent = "Preparing...";
    byId("cancel-upload").hidden = kind !== "upload";
    byId("cancel-upload").disabled = false;
    setWorkspaceBusy(true);
  }

  function transferErrors(errors) {
    byId("transfer-errors").replaceChildren();
    (errors || []).forEach(function (error) {
      var li = document.createElement("li");
      li.textContent = typeof error === "string" ? error : (error.error || error.message || JSON.stringify(error));
      byId("transfer-errors").appendChild(li);
    });
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) { window.setTimeout(resolve, milliseconds); });
  }

  function renderMoveJob(job) {
    var total = Number(job.bytes_total) || Number(job.total) || 1;
    var completed = Number(job.bytes_total) ? (Number(job.bytes_done) || 0) : (Number(job.completed) || 0);
    byId("transfer-progress").value = job.status === "done" ? 100 : Math.min(100, 100 * completed / total);
    var status = job.message || (job.status === "done" ? "Move completed." : "Moving...");
    byId("transfer-message").textContent = status + " " + (job.completed || 0) + " / " + (job.total || 0) + " items" + (job.bytes_total ? " · " + bytes(job.bytes_done || 0) + " / " + bytes(job.bytes_total) : "");
    transferErrors(job.errors);
  }

  async function startMove(event) {
    event.preventDefault();
    if (state.busy || !state.selected.size) { return; }
    var destination = relativePath(byId("move-destination").value);
    var selected = Array.from(state.selected);
    byId("move-panel").hidden = true;
    beginTransfer("move");
    notify("");
    try {
      var data = await api("/api/move", "POST", { workspace: state.workspace.id, paths: selected, destination: destination });
      var job = data.job;
      renderMoveJob(job);
      while (job.status === "running" || job.status === "pending") {
        await sleep(350);
        // Retry transient network failures while retaining the job ID. A retry
        // polls the existing operation and never starts a duplicate move.
        try { data = await api("/api/jobs/" + encodeURIComponent(job.id)); }
        catch (error) {
          // A restarted server cannot resume an expired in-memory job record.
          if (error.status && error.status >= 400 && error.status < 500) { throw error; }
          byId("transfer-message").textContent = "Move continues on the host. Reconnecting to its progress...";
          await sleep(1500);
          continue;
        }
        job = data.job;
        renderMoveJob(job);
      }
      notify(job.status === "done" && !(job.errors || []).length ? "Move completed." : "Move finished with errors. See the transfer details.", job.status === "error" || (job.errors || []).length ? "error" : "info");
    } catch (error) {
      byId("transfer-message").textContent = "Move could not be completed.";
      transferErrors([error.message]);
      reportError(error);
    } finally {
      state.transfer = null;
      setWorkspaceBusy(false);
    }
    await openDirectory(state.path);
  }

  /* A raw request per file avoids multipart parsing and buffering entire
   * uploads in JavaScript. Relative names retain directory structure. Empty
   * directory markers use a trailing slash and an empty request body.
   */
  function uploadOne(item, workspaceId, directory, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      state.transfer.xhr = xhr;
      xhr.open("POST", apiUrl("/api/upload", { workspace: workspaceId, path: directory, name: item.path }));
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = function (event) { onProgress(event.loaded); };
      xhr.onload = function () {
        var data;
        try { data = JSON.parse(xhr.responseText); }
        catch (error) { reject(new Error("The server returned an unreadable upload response.")); return; }
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(data.error || "Upload failed (HTTP " + xhr.status + ").")); }
        else { resolve(data); }
      };
      xhr.onerror = function () { reject(new Error("Connection lost during upload.")); };
      xhr.onabort = function () { reject(new Error("Upload cancelled.")); };
      xhr.send(item.file || new Blob([]));
    });
  }

  async function uploadItems(items) {
    if (state.busy || !state.workspace || !items.length) { return; }
    var workspaceId = state.workspace.id;
    var directory = state.path;
    beginTransfer("upload");
    notify("");
    var totalBytes = items.reduce(function (sum, item) { return sum + (item.file ? item.file.size : 0); }, 0);
    var completedBytes = 0;
    var succeeded = 0;
    var errors = [];
    var cancelled = false;
    try {
      for (var index = 0; index < items.length; index += 1) {
        if (state.transfer.cancelled) { cancelled = true; break; }
        var item = items[index];
        var itemSize = item.file ? item.file.size : 0;
        byId("transfer-message").textContent = "Uploading " + (index + 1) + " / " + items.length + ": " + item.path;
        try {
          await uploadOne(item, workspaceId, directory, function (loaded) {
            byId("transfer-progress").value = totalBytes ? Math.min(100, 100 * (completedBytes + Math.min(loaded, itemSize)) / totalBytes) : 100 * index / items.length;
          });
          succeeded += 1;
        } catch (error) {
          errors.push(item.path + ": " + error.message);
          transferErrors(errors);
          if (state.transfer.cancelled) { cancelled = true; break; }
        }
        completedBytes += itemSize;
        byId("transfer-progress").value = totalBytes ? Math.min(100, 100 * completedBytes / totalBytes) : 100 * (index + 1) / items.length;
      }
      var summary = (cancelled ? "Upload cancelled. " : "Upload finished. ") + succeeded + " / " + items.length + " items uploaded.";
      byId("transfer-message").textContent = summary;
      notify(summary + (errors.length ? " See the transfer details for errors." : ""), errors.length ? "error" : "info");
      if (!cancelled) { byId("transfer-progress").value = 100; }
    } finally {
      state.transfer = null;
      byId("cancel-upload").hidden = true;
      setWorkspaceBusy(false);
      byId("files-input").value = "";
      byId("folder-input").value = "";
    }
    await openDirectory(directory);
  }

  function filesToItems(files) {
    return Array.from(files).map(function (file) { return { file: file, path: file.webkitRelativePath || file.name }; });
  }

  async function walkDroppedEntry(entry, prefix, output) {
    var path = prefix + entry.name;
    if (entry.isFile) {
      var file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
      output.push({ file: file, path: path });
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      var children = [];
      // Browsers may return batches instead of every child in one read.
      while (true) {
        var batch = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
        if (!batch.length) { break; }
        children = children.concat(Array.from(batch));
      }
      if (!children.length) { output.push({ file: null, path: path + "/" }); }
      for (var index = 0; index < children.length; index += 1) {
        await walkDroppedEntry(children[index], path + "/", output);
      }
    }
  }

  async function receiveDrop(event) {
    event.preventDefault();
    byId("drop-zone").classList.remove("dragging");
    if (state.busy || !state.workspace) { return; }
    // Capture entries and Files synchronously: drag data expires after the
    // browser returns from the drop event handler.
    var files = Array.from(event.dataTransfer.files || []);
    var entries = Array.from(event.dataTransfer.items || []).filter(function (item) { return item.kind === "file"; }).map(function (item) {
      return item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    });
    var items = [];
    if (entries.length && entries.every(Boolean)) {
      setWorkspaceBusy(true);
      notify("Reading dropped folders...");
      try {
        for (var index = 0; index < entries.length; index += 1) { await walkDroppedEntry(entries[index], "", items); }
      } finally { setWorkspaceBusy(false); }
    } else { items = filesToItems(files); }
    await uploadItems(items);
  }

  /* Notes have their own dirty and request state. Switching application tabs
   * does not reset either editor, and notes do not need an active workspace.
   */
  function updateNoteState() {
    byId("note-name").readOnly = !state.note.isNew;
    byId("save-note").textContent = state.note.isNew ? "Create note" : "Save note";
    byId("save-note").disabled = state.noteBusy || (!state.note.isNew && !state.noteDirty);
    byId("reload-note").disabled = state.noteBusy || state.note.isNew;
    byId("delete-note").disabled = state.noteBusy || state.note.isNew;
    byId("new-note").disabled = state.noteBusy;
    byId("refresh-notes").disabled = state.noteBusy;
    byId("note-name").disabled = state.noteBusy;
    byId("note-editor").disabled = state.noteBusy;
    byId("note-edit-status").textContent = state.noteBusy ? "Working..." : (state.noteDirty ? "Unsaved changes" : (state.note.isNew ? "New note" : "Saved"));
    document.querySelectorAll("#note-list button").forEach(function (button) {
      button.setAttribute("aria-pressed", String(!state.note.isNew && button.dataset.name === state.note.name));
      button.disabled = state.noteBusy;
    });
  }

  async function refreshNotes() {
    var data = await api("/api/notes");
    state.notesLoaded = true;
    byId("note-list").replaceChildren();
    byId("notes-summary").textContent = data.notes.length ? data.notes.length + " saved note(s)" : "No saved notes yet.";
    data.notes.forEach(function (note) {
      var li = document.createElement("li");
      var button = makeButton(note.name, function () { return openNote(note.name); });
      button.dataset.name = note.name;
      button.title = bytes(note.size) + " · Modified: " + dateLabel(note.modified);
      li.appendChild(button);
      byId("note-list").appendChild(li);
    });
    updateNoteState();
  }

  async function showNotepad() {
    showMain("notepad");
    if (!state.notesLoaded) { await refreshNotes(); }
  }

  function canLeaveNote() {
    return !state.noteBusy && (!state.noteDirty || window.confirm("Discard unsaved changes to this note?"));
  }

  function newNote() {
    if (!canLeaveNote()) { return; }
    state.noteRequest += 1;
    state.note = { name: "", revision: null, isNew: true };
    state.noteDirty = false;
    byId("note-name").value = "";
    byId("note-editor").value = "";
    updateNoteState();
    byId("note-name").focus();
  }

  async function openNote(name, reload) {
    if ((!reload && !state.note.isNew && state.note.name === name) || !canLeaveNote()) { return; }
    var request = ++state.noteRequest;
    state.noteBusy = true;
    updateNoteState();
    try {
      var data = await api(apiUrl("/api/notes", { name: name }));
      if (request !== state.noteRequest) { return; }
      state.note = { name: data.name, revision: data.revision, isNew: false };
      state.noteDirty = false;
      byId("note-name").value = data.name;
      byId("note-editor").value = data.content;
    } finally {
      state.noteBusy = false;
      updateNoteState();
    }
  }

  async function saveNote(event) {
    event.preventDefault();
    if (state.noteBusy) { return; }
    var name = byId("note-name").value;
    if (!name.trim()) { byId("note-name").focus(); throw new Error("Enter a note name."); }
    var content = byId("note-editor").value;
    var isNew = state.note.isNew;
    state.noteBusy = true;
    updateNoteState();
    try {
      var data = await api("/api/notes", isNew ? "POST" : "PUT", { name: name, content: content, revision: state.note.revision });
      // GET also supports servers whose save response only acknowledges success.
      if (!data.name || data.revision === undefined) { data = await api(apiUrl("/api/notes", { name: name })); }
      state.note = { name: data.name, revision: data.revision, isNew: false };
      byId("note-name").value = data.name;
      state.noteDirty = false;
      await refreshNotes();
      notify(isNew ? "Note created." : "Note saved.");
    } finally {
      state.noteBusy = false;
      updateNoteState();
    }
  }

  async function deleteNote() {
    if (state.noteBusy || state.note.isNew) { return; }
    if (!window.confirm('Delete note "' + state.note.name + '" permanently?' + (state.noteDirty ? " Unsaved changes will also be lost." : ""))) { return; }
    state.noteBusy = true;
    updateNoteState();
    try {
      await api(apiUrl("/api/notes", { name: state.note.name }), "DELETE");
      state.note = { name: "", revision: null, isNew: true };
      state.noteDirty = false;
      byId("note-name").value = "";
      byId("note-editor").value = "";
      await refreshNotes();
      notify("Note deleted.");
    } finally {
      state.noteBusy = false;
      updateNoteState();
    }
  }

  function setTheme(theme) {
    var light = theme === "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    byId("theme-toggle").textContent = light ? "Dark mode" : "Light mode";
    byId("theme-toggle").setAttribute("aria-pressed", String(light));
    try { localStorage.setItem("frisbee.theme", light ? "light" : "dark"); } catch (error) { /* Storage is optional. */ }
  }

  function initialize() {
    var theme = "dark";
    try {
      theme = localStorage.getItem("frisbee.theme") || "dark";
      byId("absolute-path").value = localStorage.getItem("frisbee.absolutePath") || "";
    } catch (error) { /* Private browsing can disable local storage. */ }
    setTheme(theme);
    updateNoteState();
    // These controls intentionally reset on every page load; only the existing
    // theme and absolute-path preferences belong in persistent browser storage.
    byId("show-previews").checked = state.showPreviews;
    byId("hide-hidden-folders").checked = state.hideHiddenFolders;
    resetDirectorySearch();
    listen("theme-toggle", "click", function () { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); });
    listen("workspace-tab", "click", function () { showMain("workspace"); });
    listen("notepad-tab", "click", showNotepad);
    listen("workspace-form", "submit", chooseWorkspace);
    document.querySelectorAll('input[name="workspace-mode"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        var absolute = document.querySelector('input[name="workspace-mode"]:checked').value === "absolute";
        byId("absolute-path").disabled = !absolute;
        byId("absolute-path").required = absolute;
        if (absolute) { byId("absolute-path").focus(); }
      });
    });
    listen("change-workspace", "click", changeWorkspace);
    listen("refresh-directory", "click", function () { return openDirectory(state.path); });
    listen("new-directory", "click", createDirectory);
    listen("show-previews", "change", function (event) {
      if (state.busy) { return; }
      state.showPreviews = event.target.checked;
      renderEntries();
    });
    listen("hide-hidden-folders", "change", function (event) {
      if (state.busy) { return; }
      state.hideHiddenFolders = event.target.checked;
      renderEntries();
    });
    listen("directory-search", "input", function (event) {
      if (state.busy) { return; }
      state.searchQuery = event.target.value;
      renderEntries();
    });
    listen("select-all", "change", function (event) {
      if (state.busy) { return; }
      state.selected.clear();
      if (event.target.checked) { visibleEntries().forEach(function (entry) { state.selected.add(entry.path); }); }
      document.querySelectorAll(".entry-checkbox").forEach(function (checkbox) { checkbox.checked = event.target.checked; });
      updateSelection();
    });
    listen("download-selection", "click", downloadSelection);
    listen("delete-selection", "click", function () { return deleteEntries(Array.from(state.selected)); });
    listen("move-selection", "click", openMovePanel);
    listen("move-form", "submit", startMove);
    listen("cancel-move", "click", function () { byId("move-panel").hidden = true; });
    listen("browse-destination", "click", function () { return browseDestination(relativePath(byId("move-destination").value)); });
    listen("destination-root", "click", function () { return browseDestination(""); });
    listen("destination-parent", "click", function () { return browseDestination(parentPath(state.destination)); });
    listen("destination-choose", "click", function () {
      byId("move-destination").value = state.destination || "/";
      byId("destination-browser").hidden = true;
    });
    listen("back-to-directory", "click", function () { return openDirectory(state.path); });
    byId("back-to-directory").setAttribute("data-workspace-action", "");
    listen("edit-file", "click", function () {
      byId("file-editor").readOnly = false;
      byId("edit-file").hidden = true;
      byId("discard-file").hidden = false;
      updateFileDirty(false);
      byId("file-editor").focus();
    });
    listen("file-editor", "input", function () { updateFileDirty(byId("file-editor").value !== state.file.content); });
    listen("save-file", "click", saveFile);
    listen("discard-file", "click", discardFile);
    listen("preview-image", "error", function () {
      if (byId("image-preview").hidden || !byId("preview-image").hasAttribute("src")) { return; }
      byId("preview-status").textContent = "This image could not be displayed. Download it to open it on your device.";
      byId("preview-status").hidden = false;
    });
    listen("preview-video", "error", function () {
      if (byId("video-preview").hidden || !byId("preview-video").hasAttribute("src") || !byId("preview-video").error) { return; }
      byId("preview-status").textContent = "This video could not be played. Its format may be unsupported by this browser. Download it to open it on your device.";
      byId("preview-status").hidden = false;
    });
    listen("preview-video", "loadeddata", function () {
      if (!byId("video-preview").hidden) { byId("preview-status").hidden = true; }
    });
    listen("upload-files", "click", function () { byId("files-input").click(); });
    listen("upload-folder", "click", function () { byId("folder-input").click(); });
    listen("files-input", "change", function (event) { return uploadItems(filesToItems(event.target.files)); });
    listen("folder-input", "change", function (event) { return uploadItems(filesToItems(event.target.files)); });
    listen("cancel-upload", "click", function () {
      if (state.transfer && state.transfer.kind === "upload") {
        state.transfer.cancelled = true;
        byId("cancel-upload").disabled = true;
        if (state.transfer.xhr) { state.transfer.xhr.abort(); }
      }
    });
    var dropZone = byId("drop-zone");
    dropZone.addEventListener("dragover", function (event) {
      event.preventDefault();
      if (!state.busy) { dropZone.classList.add("dragging"); }
    });
    dropZone.addEventListener("dragleave", function (event) {
      if (!dropZone.contains(event.relatedTarget)) { dropZone.classList.remove("dragging"); }
    });
    listen("drop-zone", "drop", receiveDrop);
    // Prevent dropping outside the upload area from replacing the application.
    window.addEventListener("dragover", function (event) { event.preventDefault(); });
    window.addEventListener("drop", function (event) { event.preventDefault(); });
    listen("new-note", "click", newNote);
    listen("refresh-notes", "click", refreshNotes);
    listen("note-form", "submit", saveNote);
    listen("reload-note", "click", function () { return openNote(state.note.name, true); });
    listen("delete-note", "click", deleteNote);
    ["note-name", "note-editor"].forEach(function (id) {
      listen(id, "input", function () { state.noteDirty = true; updateNoteState(); });
    });
    window.addEventListener("beforeunload", function (event) {
      if (state.fileDirty || state.noteDirty || state.transfer) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (!byId("notepad-view").hidden) {
          event.preventDefault();
          if (!state.noteBusy) { byId("note-form").requestSubmit(); }
        } else if (state.file && !byId("text-preview").hidden) {
          event.preventDefault();
          saveFile().catch(reportError);
        }
      }
    });
  }

  initialize();
}());
