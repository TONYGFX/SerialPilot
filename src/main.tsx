/**
 * Browser entry point for the Tauri desktop shell.
 * It mounts the application once while implementation details remain in App
 * and its focused feature modules.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
