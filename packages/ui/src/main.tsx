import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { takeToken } from "./api";
import { App, Notice } from "./App";
import "./styles.css";

const token = takeToken();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {token ? (
      <App token={token} />
    ) : (
      <Notice title="Open this page from its link">
        The address needs the access key that <code>vertskim ui</code> prints, or that your assistant gets from the{" "}
        <code>graph_open_ui</code> tool. It keeps other programs on this computer from reading your project.
      </Notice>
    )}
  </StrictMode>,
);
