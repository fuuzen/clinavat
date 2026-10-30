import { ws } from "msw";
import { gitState, listFiles, readFile } from "./filesystem";

const terminal = ws.link(/\/api\/projects\/[^/]+\/terminal$/);
const prompt = "\x1b[32mdeveloper@demo\x1b[0m:\x1b[34m~/project\x1b[0m$ ";
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

function run(line: string): string {
  const [command = "", ...args] = line.trim().split(/\s+/);
  switch (command) {
    case "":
      return "";
    case "help":
      return "演示终端支持：ls [目录]、cat <文件>、git status、git diff、pwd、whoami、echo、clear\n";
    case "ls":
      return listFiles(args[0] || "").map((entry) => entry.type === "directory" ? `\x1b[34m${entry.name}/\x1b[0m` : entry.name).join("  ") + "\n";
    case "cat":
      return readFile(args[0] || "") ?? `cat: ${args[0] || ""}: 没有那个文件或目录\n`;
    case "pwd":
      return "/home/developer/project\n";
    case "whoami":
      return "developer\n";
    case "echo":
      return args.join(" ") + "\n";
    case "clear":
      return "\x1b[2J\x1b[H";
    case "git":
      if (args[0] === "status") return `位于分支 ${gitState().branch}\n${gitState().status}\n`;
      if (args[0] === "diff") return gitState().diff + "\n";
      return "演示终端仅支持 git status 与 git diff\n";
    default:
      return `${command}: 在线预览中不可用，输入 help 查看支持的命令\n`;
  }
}

export const terminalHandlers = [
  terminal.addEventListener("connection", ({ client }) => {
    let buffer = "";
    const write = (data: string) => client.send(JSON.stringify({ type: "output", data }));
    client.send(JSON.stringify({ type: "ready" }));
    write(crlf("这是在线预览的模拟终端，输入 help 查看支持的命令。\n") + prompt);
    client.addEventListener("message", (event) => {
      let message: { type?: string; data?: string };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type !== "input" || !message.data) return;
      for (const character of message.data) {
        if (character === "\r") {
          write("\r\n" + crlf(run(buffer)) + prompt);
          buffer = "";
        } else if (character === "\x7f") {
          if (buffer) write("\b \b");
          buffer = buffer.slice(0, -1);
        } else if (character === "\x03") {
          write("^C\r\n" + prompt);
          buffer = "";
        } else if (character >= " ") {
          buffer += character;
          write(character);
        }
      }
    });
  }),
];
