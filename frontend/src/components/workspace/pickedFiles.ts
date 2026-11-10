export interface PickedFile {
  file: File;
  /** Relative to the directory the files are uploaded into; folders keep their structure. */
  path: string;
}

export interface PickedFiles {
  files: PickedFile[];
  /** Entries inside .git or the runtime's .bin, which the Hub never writes. */
  skipped: number;
}

const isProtected = (name: string) => name === ".git" || name === ".bin";

export function fromFileList(list: FileList | File[]): PickedFiles {
  const files = Array.from(list, (file) => ({ file, path: file.webkitRelativePath || file.name }));
  const allowed = files.filter((item) => !item.path.split("/").some(isProtected));
  return { files: allowed, skipped: files.length - allowed.length };
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, picked: PickedFiles): Promise<void> {
  const path = prefix + entry.name;
  if (isProtected(entry.name)) {
    picked.skipped++;
  } else if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    picked.files.push({ file, path });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // A directory is read in batches; an empty batch marks the end.
    for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
      for (const child of batch) await walk(child, `${path}/`, picked);
    }
  }
}

export async function fromDrop(transfer: DataTransfer): Promise<PickedFiles> {
  // The browser clears the data transfer once the drop event returns, so everything is taken up front.
  const plain = Array.from(transfer.files);
  const entries = Array.from(transfer.items, (item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null));
  if (!entries.some(Boolean)) return fromFileList(plain);
  const picked: PickedFiles = { files: [], skipped: 0 };
  try {
    for (const entry of entries) if (entry) await walk(entry, "", picked);
  } catch {
    // An unreadable folder falls back to the top-level files the browser always provides.
    return fromFileList(plain);
  }
  return picked;
}
