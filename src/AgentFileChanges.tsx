import { useEffect, useState } from "react";
import { FilePlus, FolderPlus, Pencil, Save, Trash, X } from "lucide-react";
import { request, type Peer } from "./api";
import "./agent-desktop.css";

// Changing files, for agents allowed to: a new file or folder in the current
// folder, and editing or removing the file that is open. Changes are immediate.
type Props = {
  peer: Peer;
  root: number;
  dir: string;
  file: { path: string; text: string } | null;
  onChanged: (opened?: { path: string; text: string } | null) => void;
  onError: (error: unknown) => void;
};
const join = (dir: string, name: string) => (dir ? `${dir.replace(/\/$/, "")}/${name}` : name);
export default function AgentFileChanges({ peer, root, dir, file, onChanged, onError }: Props) {
  const [newFile, setNewFile] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { setEditing(false); setConfirmDelete(false); setDraft(file?.text ?? ""); }, [file?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = async (body: Record<string, unknown>, done: string, opened?: { path: string; text: string } | null) => {
    if (busy) return;
    setBusy(true); setNote("");
    try {
      await request(peer, "/api/browser/files/change", { method: "POST", body: JSON.stringify({ root, ...body }) });
      setNote(done);
      onChanged(opened);
    } catch (e) {
      if ((e as { status?: number }).status === 401) onError(e); else setNote((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <div className="ag-changes" aria-label="Change files">
      <div className="ag-changes-new">
        <form onSubmit={(event) => { event.preventDefault(); if (newFile.trim()) void change({ op: "write", path: join(dir, newFile.trim()), content: "" }, `Created ${newFile.trim()}.`, { path: join(dir, newFile.trim()), text: "" }).then(() => setNewFile("")); }}>
          <input aria-label="New file name" placeholder="New file name" value={newFile} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setNewFile(event.target.value)} />
          <button className="ag-secondary ag-small" type="submit" disabled={busy || !newFile.trim()}><FilePlus size={14} /> New file</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); if (newFolder.trim()) void change({ op: "mkdir", path: join(dir, newFolder.trim()) }, `Created folder ${newFolder.trim()}.`).then(() => setNewFolder("")); }}>
          <input aria-label="New folder name" placeholder="New folder name" value={newFolder} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setNewFolder(event.target.value)} />
          <button className="ag-secondary ag-small" type="submit" disabled={busy || !newFolder.trim()}><FolderPlus size={14} /> New folder</button>
        </form>
      </div>
      {file && !editing && (
        <div className="ag-changes-file">
          <button className="ag-secondary ag-small" type="button" disabled={busy} onClick={() => { setDraft(file.text); setEditing(true); }}><Pencil size={14} /> Edit {file.path.split("/").at(-1)}</button>
          {confirmDelete ? (
            <>
              <button className="ag-danger ag-small" type="button" disabled={busy} onClick={() => void change({ op: "rm", path: file.path }, `Deleted ${file.path}.`, null).then(() => setConfirmDelete(false))}><Trash size={14} /> Confirm delete</button>
              <button className="ag-secondary ag-small" type="button" onClick={() => setConfirmDelete(false)}><X size={14} /> Keep it</button>
            </>
          ) : (
            <button className="ag-secondary ag-small" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash size={14} /> Delete</button>
          )}
        </div>
      )}
      {file && editing && (
        <form className="ag-changes-editor" onSubmit={(event) => { event.preventDefault(); void change({ op: "write", path: file.path, content: draft }, `Saved ${file.path}.`, { path: file.path, text: draft }).then(() => setEditing(false)); }}>
          <textarea aria-label={`Edit ${file.path}`} value={draft} rows={14} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
          <div>
            <button className="ag-primary ag-small" type="submit" disabled={busy}><Save size={14} /> Save</button>
            <button className="ag-secondary ag-small" type="button" disabled={busy} onClick={() => setEditing(false)}><X size={14} /> Cancel</button>
          </div>
        </form>
      )}
      {note && <p className="ag-quiet" role="status">{note}</p>}
    </div>
  );
}
