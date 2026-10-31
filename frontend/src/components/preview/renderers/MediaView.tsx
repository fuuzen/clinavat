import { useState } from "react";
import { Music, VideoOff } from "lucide-react";
import { formatBytes } from "../../../api";
import { detectKind, fileName, type RendererProps } from "../fileKinds";
import { PreviewMessage } from "./PreviewStates";

export default function MediaView({ source }: RendererProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <PreviewMessage source={source} icon={VideoOff} title="浏览器无法播放" detail="这个文件的编码格式不受当前浏览器支持，可以下载后用本地播放器打开。" />;
  }
  if (detectKind(source.path) === "video") {
    return (
      <div className="media-viewer">
        <video src={source.url} controls preload="metadata" playsInline onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className="media-viewer">
      <div className="audio-card">
        <span className="audio-disc">
          <Music size={30} strokeWidth={1.6} />
        </span>
        <strong title={source.path}>{fileName(source.path)}</strong>
        <small>{formatBytes(source.size)}</small>
        <audio src={source.url} controls preload="metadata" onError={() => setFailed(true)} />
      </div>
    </div>
  );
}
