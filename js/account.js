import {
  GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, updateProfile,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { ref, get, set, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { auth, db } from "./firebase.js";
import { toast, authErrorMessage } from "./common.js";
import { imageToWebp, urlToWebp, renderAvatar } from "./image.js";

const $ = (id) => document.getElementById(id);
const CAMERA_ICON = $("su-preview").innerHTML;

/**
 * Cuida de login (e-mail, Google, Apple), cadastro, "esqueci minha senha",
 * perfil (users/{uid}/profile) e do menu de perfil no topo.
 *  - show(nome): exibe uma das seções da página
 *  - onReady(user, profile): usuário logado com cadastro completo
 *  - onSignedOut(): usuário saiu
 */
export function initAccount({ show, onReady, onSignedOut }) {
  let signupBusy = false;  // evita que o onAuthStateChanged atropele o cadastro
  let mode = "signup";     // "signup" | "complete"
  let photoData = null;    // data URL WebP da foto escolhida

  /* ---------------- Rotas por hash (#entrar, #cadastro, #esqueci) ---------------- */
  function route() {
    if (auth.currentUser) return;
    const h = location.hash;
    if (h === "#cadastro") openSignup();
    else if (h === "#esqueci") openForgot();
    else { show("login"); }
  }
  window.addEventListener("hashchange", route);

  onAuthStateChanged(auth, async (u) => {
    if (!u) {
      renderProfileButton(null);
      onSignedOut();
      route();
      return;
    }
    if (signupBusy) return;
    await afterSignIn(u);
  });

  async function afterSignIn(u) {
    let profile = null;
    try {
      profile = (await get(ref(db, `users/${u.uid}/profile`))).val();
    } catch (err) {
      console.error(err);
    }
    if (!profile || !profile.firstName || !profile.lastName || !profile.birthDate || !profile.photo) {
      openComplete(u, profile);
      return;
    }
    finish(u, profile);
  }

  function finish(u, profile) {
    renderProfileButton(u, profile);
    if (location.hash) history.replaceState(null, "", location.pathname);
    onReady(u, profile);
  }

  /* ---------------- Login com e-mail ---------------- */
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("login-btn");
    $("login-error").textContent = "";
    const email = $("email").value.trim(), pass = $("password").value;
    if (!email || !pass) { $("login-error").textContent = "Preencha e-mail e senha."; return; }
    busy(btn, true, "Entrando…");
    try {
      await signInWithEmailAndPassword(auth, email, pass);
      $("password").value = "";
    } catch (err) {
      $("login-error").textContent = authErrorMessage(err);
    } finally {
      busy(btn, false);
    }
  });

  /* ---------------- Google e Apple ---------------- */
  const google = new GoogleAuthProvider();
  google.setCustomParameters({ prompt: "select_account" });

  const apple = new OAuthProvider("apple.com");
  apple.addScope("email");
  apple.addScope("name");
  apple.setCustomParameters({ locale: "pt_BR" });

  async function social(provider, btn) {
    $("login-error").textContent = "";
    busy(btn, true, "Abrindo…");
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (!["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(err.code)) {
        $("login-error").textContent = authErrorMessage(err);
      }
    } finally {
      busy(btn, false);
    }
  }
  $("google-btn").addEventListener("click", (e) => social(google, e.currentTarget));
  $("apple-btn").addEventListener("click", (e) => social(apple, e.currentTarget));

  /* ---------------- Esqueci minha senha ---------------- */
  function openForgot() {
    $("fg-email").value = $("email").value.trim();
    $("fg-error").textContent = "";
    $("forgot-form").hidden = false;
    $("fg-done").hidden = true;
    show("forgot");
    $("fg-email").focus();
  }

  $("forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("fg-email").value.trim();
    $("fg-error").textContent = "";
    if (!/^\S+@\S+\.\S+$/.test(email)) { $("fg-error").textContent = "Digite um e-mail válido."; return; }
    const btn = $("fg-btn");
    busy(btn, true, "Enviando…");
    try {
      auth.languageCode = "pt-BR";
      await sendPasswordResetEmail(auth, email);
      $("fg-sent").textContent = email;
      $("forgot-form").hidden = true;
      $("fg-done").hidden = false;
    } catch (err) {
      if (err.code === "auth/user-not-found") { // não revela se a conta existe
        $("fg-sent").textContent = email;
        $("forgot-form").hidden = true;
        $("fg-done").hidden = false;
      } else {
        $("fg-error").textContent = authErrorMessage(err);
      }
    } finally {
      busy(btn, false);
    }
  });

  /* ---------------- Cadastro / completar cadastro ---------------- */
  function resetPhoto() {
    photoData = null;
    $("su-preview").innerHTML = CAMERA_ICON;
    $("su-photo-status").textContent = "JPG, PNG ou HEIC · salva em .webp";
  }

  function setPhoto(dataUrl) {
    photoData = dataUrl;
    renderAvatar($("su-preview"), dataUrl);
    const kb = Math.round((dataUrl.length * 3) / 4 / 1024);
    $("su-photo-status").textContent = `Foto pronta · WebP · ${kb} KB`;
  }

  function openSignup() {
    mode = "signup";
    $("su-title").textContent = "Criar conta";
    $("su-sub").textContent = "Preencha seus dados para começar a apresentar.";
    $("su-btn").textContent = "Criar conta";
    $("su-cred").hidden = false;
    $("su-foot-signup").hidden = false;
    $("su-foot-complete").hidden = true;
    $("su-error").textContent = "";
    $("su-birth").max = new Date().toISOString().slice(0, 10);
    show("signup");
  }

  async function openComplete(u, profile) {
    mode = "complete";
    $("su-title").textContent = "Complete seu cadastro";
    $("su-sub").textContent = "Só falta confirmar alguns dados para liberar o painel.";
    $("su-btn").textContent = "Salvar e continuar";
    $("su-cred").hidden = true;
    $("su-foot-signup").hidden = true;
    $("su-foot-complete").hidden = false;
    $("su-error").textContent = "";
    $("su-birth").max = new Date().toISOString().slice(0, 10);

    const parts = (u.displayName || "").trim().split(/\s+/).filter(Boolean);
    if (!$("su-first").value) $("su-first").value = profile?.firstName || parts[0] || "";
    if (!$("su-last").value) $("su-last").value = profile?.lastName || parts.slice(1).join(" ");
    if (!$("su-birth").value && profile?.birthDate) $("su-birth").value = profile.birthDate;

    if (profile?.photo) setPhoto(profile.photo);
    else if (!photoData && u.photoURL) {
      $("su-photo-status").textContent = "Importando sua foto…";
      try { setPhoto(await urlToWebp(u.photoURL)); }
      catch { resetPhoto(); }
    }
    show("signup");
  }

  $("su-photo-btn").addEventListener("click", () => $("su-photo").click());
  $("su-photo").addEventListener("change", async () => {
    const file = $("su-photo").files[0];
    $("su-photo").value = "";
    if (!file) return;
    $("su-error").textContent = "";
    $("su-photo-status").textContent = "Convertendo para WebP…";
    try {
      setPhoto(await imageToWebp(file));
    } catch (err) {
      resetPhoto();
      $("su-error").textContent = err.message;
    }
  });

  $("su-signout").addEventListener("click", () => signOut(auth));

  function readForm() {
    const data = {
      firstName: $("su-first").value.trim(),
      lastName: $("su-last").value.trim(),
      birthDate: $("su-birth").value,
      email: $("su-email").value.trim(),
      pass: $("su-pass").value,
      pass2: $("su-pass2").value,
    };
    if (!photoData) return [null, "Escolha uma foto de perfil."];
    if (!data.firstName) return [null, "Informe seu nome."];
    if (!data.lastName) return [null, "Informe seu sobrenome."];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.birthDate)) return [null, "Informe sua data de nascimento."];
    const birth = new Date(data.birthDate + "T12:00:00");
    const age = (Date.now() - birth) / (365.25 * 864e5);
    if (isNaN(age) || age < 0) return [null, "A data de nascimento não pode estar no futuro."];
    if (age > 120) return [null, "Confira a data de nascimento."];
    if (mode === "signup") {
      if (!/^\S+@\S+\.\S+$/.test(data.email)) return [null, "Digite um e-mail válido."];
      if (data.pass.length < 6) return [null, "A senha precisa ter pelo menos 6 caracteres."];
      if (data.pass !== data.pass2) return [null, "As senhas não conferem."];
    }
    return [data, null];
  }

  async function saveProfile(u, data) {
    const profile = {
      firstName: data.firstName,
      lastName: data.lastName,
      birthDate: data.birthDate,
      email: u.email || data.email || "",
      photo: photoData,
      provider: u.providerData[0]?.providerId || "password",
      updatedAt: serverTimestamp(),
    };
    await set(ref(db, `users/${u.uid}/profile`), profile);
    try { await updateProfile(u, { displayName: `${data.firstName} ${data.lastName}` }); } catch {}
    return { ...profile, updatedAt: Date.now() };
  }

  $("signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("su-error").textContent = "";
    const [data, error] = readForm();
    if (error) { $("su-error").textContent = error; return; }

    const btn = $("su-btn");
    busy(btn, true, "Salvando…");
    try {
      let u = auth.currentUser;
      if (mode === "signup") {
        signupBusy = true;
        u = (await createUserWithEmailAndPassword(auth, data.email, data.pass)).user;
        $("su-pass").value = $("su-pass2").value = "";
      }
      const profile = await saveProfile(u, data);
      signupBusy = false;
      toast(mode === "signup" ? "Conta criada! Bem-vindo(a)." : "Cadastro concluído!", "ok");
      clearSignup();
      finish(u, profile);
    } catch (err) {
      console.error(err);
      const created = signupBusy && auth.currentUser;
      signupBusy = false;
      if (created) {
        // A conta foi criada mas o perfil não salvou: continua no modo "completar"
        openComplete(auth.currentUser, null);
        btn.dataset.label = "Salvar e continuar";
        $("su-error").textContent = "Sua conta foi criada, mas o perfil não pôde ser salvo. Tente de novo. (" + (err.code || err.message) + ")";
      } else {
        $("su-error").textContent = err.code?.startsWith("auth/") ? authErrorMessage(err)
          : "Não foi possível salvar: " + (err.code === "PERMISSION_DENIED" ? "permissão negada — confira as regras do banco." : err.message);
      }
    } finally {
      busy(btn, false);
    }
  });

  function clearSignup() {
    ["su-first", "su-last", "su-birth", "su-email", "su-pass", "su-pass2"].forEach((id) => ($(id).value = ""));
    resetPhoto();
  }

  /* ---------------- Botão de perfil ---------------- */
  const pBtn = $("profile-btn"), pMenu = $("profile-menu");

  function renderProfileButton(u, profile) {
    $("profile").hidden = !u;
    closeMenu();
    if (!u) return;
    const full = profile ? `${profile.firstName} ${profile.lastName}` : (u.displayName || u.email || "");
    renderAvatar($("avatar-sm"), profile?.photo, full);
    renderAvatar($("avatar-lg"), profile?.photo, full);
    $("profile-name").textContent = profile?.firstName || full.split(" ")[0];
    $("pm-name").textContent = full;
    $("pm-email").textContent = u.email || "";
  }

  function closeMenu() {
    pMenu.hidden = true;
    pBtn.setAttribute("aria-expanded", "false");
  }

  pBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pMenu.hidden;
    pMenu.hidden = !open;
    pBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#profile")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  $("logout").addEventListener("click", async () => {
    closeMenu();
    await signOut(auth);
    history.replaceState(null, "", location.pathname);
    toast("Você saiu da sua conta.");
  });
}

function busy(btn, on, label) {
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    if (label) btn.textContent = label;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}
