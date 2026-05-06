import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function mount() {
  const container = document.getElementById("root")!;
  createRoot(container).render(<App />);
}

if (typeof Office !== "undefined") {
  Office.onReady(() => mount());
} else {
  mount();
}
