import { useMemo, useState } from "react";
import { FileWarning } from "lucide-react";
import { read, utils, type WorkBook } from "xlsx";
import { extensionOf, type RendererProps } from "../fileKinds";
import { useRawBuffer } from "../useRawBuffer";
import { CodeBlock } from "./CodeView";
import { PreviewLoading, PreviewMessage } from "./PreviewStates";

const rowLimit = 1000;
const columnLimit = 100;
const numeric = /^[-+]?[$¥€£]?[\d,]*\.?\d+(e[-+]?\d+)?%?$/i;

const parseWorkbook = (buffer: ArrayBuffer) => read(buffer, { type: "array", cellDates: true });

function SheetTable({ workbook }: { workbook: WorkBook }) {
  const [active, setActive] = useState(0);
  const name = workbook.SheetNames[active];
  const { rows, totalRows, totalColumns } = useMemo(() => {
    const sheet = workbook.Sheets[name];
    const range = sheet?.["!ref"] ? utils.decode_range(sheet["!ref"]) : undefined;
    if (!sheet || !range) return { rows: [] as string[][], totalRows: 0, totalColumns: 0 };
    const limited = { s: range.s, e: { r: Math.min(range.e.r, range.s.r + rowLimit - 1), c: Math.min(range.e.c, range.s.c + columnLimit - 1) } };
    return {
      rows: utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true, range: limited }),
      totalRows: range.e.r - range.s.r + 1,
      totalColumns: range.e.c - range.s.c + 1,
    };
  }, [workbook, name]);
  const columns = Math.min(totalColumns, columnLimit);
  const truncated = totalRows > rowLimit || totalColumns > columnLimit;
  return (
    <div className="sheet-viewer">
      <div className="preview-scroll sheet-scroll">
        {rows.length === 0 ? (
          <div className="preview-state">
            <p>这个工作表是空的</p>
          </div>
        ) : (
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="sheet-corner" />
                {Array.from({ length: columns }, (_, index) => (
                  <th key={index}>{utils.encode_col(index)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th>{rowIndex + 1}</th>
                  {Array.from({ length: columns }, (_, columnIndex) => {
                    const value = row[columnIndex] ?? "";
                    return (
                      <td key={columnIndex} className={numeric.test(value.trim()) ? "numeric" : undefined} title={value.length > 40 ? value : undefined}>
                        {value}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {(workbook.SheetNames.length > 1 || truncated) && (
        <footer className="sheet-footer">
          <div className="sheet-tabs">
            {workbook.SheetNames.length > 1 &&
              workbook.SheetNames.map((sheet, index) => (
                <button key={sheet} className={index === active ? "active" : ""} onClick={() => setActive(index)}>
                  {sheet}
                </button>
              ))}
          </div>
          {truncated && (
            <span className="sheet-note">
              仅显示前 {Math.min(totalRows, rowLimit)} 行 × {columns} 列，共 {totalRows} 行 × {totalColumns} 列
            </span>
          )}
        </footer>
      )}
    </div>
  );
}

function BinarySheet({ source }: Pick<RendererProps, "source">) {
  const state = useRawBuffer(source.url, parseWorkbook);
  if (state.status === "loading") return <PreviewLoading label="正在读取表格" />;
  if (state.status === "error") return <PreviewMessage source={source} icon={FileWarning} title="表格无法解析" detail={state.error} />;
  return <SheetTable workbook={state.value} />;
}

function TextSheet({ source }: Pick<RendererProps, "source">) {
  const content = source.content ?? "";
  const tabSeparated = extensionOf(source.path) === "tsv";
  const workbook = useMemo(() => read(content, { type: "string", raw: true, FS: tabSeparated ? "\t" : undefined }), [content, tabSeparated]);
  return <SheetTable workbook={workbook} />;
}

export default function SheetView({ source, showSource, wrap }: RendererProps) {
  if (source.content === undefined) return <BinarySheet source={source} />;
  if (showSource) {
    return (
      <div className="preview-scroll">
        <CodeBlock code={source.content} numbered wrap={wrap} />
      </div>
    );
  }
  return <TextSheet source={source} />;
}
