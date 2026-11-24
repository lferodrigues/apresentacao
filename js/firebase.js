import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

// Detecta se a configuração ainda está com os valores de exemplo
export const configOk =
  !!firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith("COLE_") &&
  !String(firebaseConfig.databaseURL || "").includes("SEU-PROJETO");

let app = null, auth = null, db = null;
if (configOk) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
}

export { app, auth, db };
