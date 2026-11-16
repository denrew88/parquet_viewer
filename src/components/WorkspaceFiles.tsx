import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Search, X } from "lucide-react";

interface FileEntry {
  id: string;
  label: string;
  path: string;
  status: "loading" | "ready" | "error";
}

export function WorkspaceFiles({
  files,
  activeId,
  onOpen,
  onClose,
}: {
  files: FileEntry[];
  activeId: string | null;
  onOpen(id: string): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const keyword = filter.trim().toLowerCase();
  const matches = files.filter(
    ({ label, path }) =>
      label.toLowerCase().includes(keyword) || path.toLowerCase().includes(keyword),
  );

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    search.current?.focus();
    return () => {
      if (element.open && typeof element.close === "function") element.close();
    };
  }, []);

  return (
    <dialog
      aria-labelledby="workspace-files-title"
      className="workspace-files"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < left ||
          event.clientX > right ||
          event.clientY < top ||
          event.clientY > bottom
        ) {
          onClose();
        }
      }}
    >
      <div className="workspace-files__heading">
        <h2 id="workspace-files-title">Open Files</h2>
        <button type="button" className="icon-button" aria-label="Close Files" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <label className="workspace-files__search">
        <Search aria-hidden="true" />
        <input
          ref={search}
          aria-label="Search open files"
          placeholder="Filter by file name or path"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      </label>
      {matches.length === 0 ? (
        <p role="status">{files.length ? "No matching files." : "No files open."}</p>
      ) : (
        <ul className="workspace-files__list">
          {matches.map((file) => (
            <li key={file.id}>
              <button
                type="button"
                aria-current={file.id === activeId ? "true" : undefined}
                onClick={() => onOpen(file.id)}
                title={file.path}
              >
                <FileSpreadsheet aria-hidden="true" />
                <span>{file.label}</span>
                {file.status !== "ready" && (
                  <small>{file.status === "loading" ? "Opening" : "Error"}</small>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
