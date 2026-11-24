# Apresentação ao vivo 📽️

Sistema web para apresentar um PDF em tempo real para várias pessoas ao mesmo tempo.

- O **apresentador** entra com usuário e senha, envia um **PDF** e recebe um **PIN de 4 números**.
- Os **visitantes** abrem o site, digitam o PIN e veem a apresentação.
- Quando o apresentador **avança ou volta** um slide, a mudança aparece **em todas as telas** na hora.

Feito com HTML, CSS e JavaScript puros, roda no **GitHub Pages** e usa o **Firebase Realtime Database** (plano gratuito Spark) e o **Firebase Authentication**.

> Desenvolvido por [feliperodrigues.net](https://feliperodrigues.net)

---

## Funcionalidades

| Apresentador (`apresentador.html`) | Visitante (`index.html`) |
|---|---|
| Login com e-mail e senha | Entrada pelo PIN de 4 números |
| Upload de PDF (arrastar e soltar), até 30 MB | Entrada direta por link: `.../?pin=1234` |
| PIN gerado automaticamente e sem repetição | Slide sincronizado em tempo real |
| Navegação por botões, teclado (← → espaço), toque e deslizar | Tela cheia (botão, tecla **F** ou duplo clique) |
| Tela cheia com controles flutuantes | Aviso quando a apresentação é encerrada |
| Contador de pessoas assistindo | Layout responsivo (celular, tablet, PC, projetor) |
| Botão para copiar o link de acesso | |
| Lista "Minhas apresentações" para retomar depois | |
| Encerrar apresentação (apaga o arquivo do banco) | |
| Controle de mais de um dispositivo (ex.: notebook no projetor + celular como controle remoto) | |

## Estrutura

```
├── index.html            # Visitante: digita o PIN e assiste
├── apresentador.html     # Apresentador: login, upload e controle
├── css/style.css         # Estilos (tema escuro, responsivo)
├── js/
│   ├── firebase-config.js  # ⚠️ suas chaves do Firebase vão aqui
│   ├── firebase.js         # Inicialização do Firebase
│   ├── common.js           # Funções compartilhadas
│   ├── pdf-render.js       # Renderização dos slides com PDF.js
│   ├── viewer.js           # Lógica do visitante
│   └── presenter.js        # Lógica do apresentador
└── database.rules.json   # Regras de segurança do Realtime Database
```

### Como os dados ficam no banco

```
sessions/{PIN}           → dono, título, nº de páginas, slide atual, pronto?
files/{PIN}/c0, c1, …    → o PDF em pedaços (base64)
viewers/{PIN}/{id}       → presença de cada visitante (some ao fechar a aba)
users/{uid}/sessions     → lista de apresentações de cada apresentador
```

O PDF é guardado no próprio Realtime Database (em pedaços), então **não é preciso o Firebase Storage** — que hoje exige o plano pago Blaze. Ao encerrar a apresentação, tudo é apagado.

---

## Configuração passo a passo

### 1. Criar o projeto no Firebase
1. Acesse <https://console.firebase.google.com> e clique em **Adicionar projeto**.
2. Dê um nome (ex.: `apresentacao`) e conclua (o Google Analytics é opcional).

### 2. Ativar o login (Authentication)
1. Menu **Build → Authentication → Começar**.
2. Em **Método de login**, ative **E-mail/senha**.
3. Na aba **Usuários**, clique em **Adicionar usuário** e crie o seu (e-mail + senha). É com ele que você entra em `apresentador.html`.
4. Em **Configurações → Domínios autorizados**, adicione: `lferodrigues.github.io` (e o seu domínio próprio, se usar).
5. *(Recomendado)* Em **Configurações → Ações do usuário**, desmarque **Ativar criação (inscrição)** para que ninguém consiga criar conta pelo navegador.

### 3. Criar o Realtime Database
1. Menu **Build → Realtime Database → Criar banco de dados**.
2. Escolha a localização (ex.: `us-central1`) e comece no **modo bloqueado**.
3. Abra a aba **Regras**, apague o conteúdo, cole todo o arquivo [`database.rules.json`](database.rules.json) e clique em **Publicar**.

### 4. Copiar as chaves para o site
1. Em **Configurações do projeto (⚙️) → Geral → Seus apps**, clique no ícone **Web `</>`** e registre o app (não precisa de Hosting).
2. Copie o objeto `firebaseConfig` mostrado e cole em [`js/firebase-config.js`](js/firebase-config.js), substituindo os valores de exemplo.
3. Confira se o `databaseURL` está presente (ele aparece depois que o Realtime Database é criado).

> As chaves do `firebaseConfig` são públicas por natureza (vão para o navegador de qualquer forma). Quem protege os dados são as **regras do banco** e o **login**.

### 5. Publicar no GitHub Pages
1. No repositório, vá em **Settings → Pages**.
2. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
3. Selecione a branch **main** e a pasta **/ (root)** e salve.
4. Em 1–2 minutos o site estará em: **<https://lferodrigues.github.io/apresentacao/>**

---

## Como usar

**Apresentador**
1. Abra `https://lferodrigues.github.io/apresentacao/apresentador.html` e faça login.
2. Escolha o PDF, dê um título e clique em **Enviar e gerar PIN**.
3. Mostre o PIN (ou envie o link) para o público.
4. Navegue com **← →**, **espaço**, os botões, tocando nas laterais do slide ou deslizando o dedo. **F** = tela cheia.
5. Ao terminar, clique em **Encerrar**.

**Visitante**
1. Abra `https://lferodrigues.github.io/apresentacao/`.
2. Digite o PIN e clique em **Assistir**.

## Testar no computador (opcional)

Por usar módulos JavaScript, abra por um servidor local (não pelo `file://`):

```bash
python -m http.server 8000
# depois acesse http://localhost:8000
```

Adicione `localhost` aos domínios autorizados do Firebase Authentication (normalmente já vem incluído).

## Limites e observações

- **Tamanho do PDF:** até 30 MB. PDFs menores carregam mais rápido para quem assiste — se possível, comprima antes (ex.: "Reduzir tamanho" no Acrobat ou ilovepdf).
- **Plano gratuito do Firebase (Spark):** 1 GB armazenado e 10 GB de download por mês, até 100 conexões simultâneas. Cada visitante baixa o PDF uma vez. Exemplo: um PDF de 5 MB para 40 pessoas ≈ 200 MB.
- **Segurança do PIN:** qualquer pessoa com o PIN pode ver a apresentação. Encerre as apresentações que não estiver usando — isso também libera espaço.
- **iPhone:** o Safari não tem tela cheia "de verdade" para páginas; o sistema usa um modo que ocupa a tela toda.
- Para restringir o envio a **um único usuário**, troque nas regras `auth != null` por `auth.uid === 'SEU_UID'` (o UID aparece na aba Usuários do Authentication).

## Tecnologias

- [Firebase](https://firebase.google.com) — Authentication e Realtime Database (SDK modular 10.12, via CDN)
- [PDF.js](https://mozilla.github.io/pdf.js/) 4.4 — renderização dos slides
- HTML, CSS e JavaScript puros (sem build)

---

Desenvolvido por **[feliperodrigues.net](https://feliperodrigues.net)**
