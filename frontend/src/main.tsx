import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { AuthCallbackPage } from "./components/layout/AuthCallbackPage";
import { primeFnosSdk } from "./lib/fnos";
import { isAuthCallbackPath } from "./lib/fnosAuth";
import { runtimeBase } from "./lib/runtime";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root 挂载点");

// 飞牛宿主的握手窗口只有 iframe 挂载后的 60 秒，必须在入口就发起，不能等用户点添加目录。
primeFnosSdk();

// 飞牛路由授权的回调页单独渲染：不挂应用壳层，否则授权回来时用户会被令牌门挡住，
// 或者白白建立一个 WS 连接。判定见 lib/fnosAuth.isAuthCallbackPath。
const callback = isAuthCallbackPath(window.location.pathname, runtimeBase());

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>{callback ? <AuthCallbackPage /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
