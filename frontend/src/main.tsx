import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { primeFnosSdk } from "./lib/fnos";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root 挂载点");

// 飞牛宿主的握手窗口只有 iframe 挂载后的 60 秒，必须在入口就发起，不能等用户点添加目录。
primeFnosSdk();

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
