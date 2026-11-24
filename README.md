# Apresentação ao vivo 📽️

Sistema web para apresentar um PDF em tempo real para várias pessoas ao mesmo tempo.

- A página inicial tem dois botões: **Apresentação** (assistir com PIN) e **Administrador** (painel).
- O **apresentador** entra com usuário e senha, envia um **PDF** e recebe um **PIN de 4 números**.
- Os **visitantes** abrem o site, digitam o PIN e veem a apresentação.
- Quando o apresentador **avança ou volta** um slide, a mudança aparece **em todas as telas** na hora.
- O apresentador pode **escrever com lápis** e **marcar com marca-texto** (várias cores), e todos veem ao vivo.
- Ao encerrar, o público pode **baixar o PDF por 24 horas**, por link ou **QR Code** gerados automaticamente.

Feito com HTML, CSS e JavaScript puros, roda no **GitHub Pages** e usa o **Firebase Realtime Database** (plano gratuito Spark) e o **Firebase Authentication**.

> Desenvolvido por [feliperodrigues.net](https://feliperodrigues.net)

---

## Funcionalidades

| Administrador (`apresentador.html`) | Apresentação / visitante (`assistir.html`) |
|---|---|
| Login com e-mail e senha, **Google** ou **Apple** | Entrada pelo PIN de 4 números |
| Upload de PDF (arrastar e soltar), até 30 MB | Entrada direta por link: `.../assistir.html?pin=1234` |
| PIN gerado automaticamente e sem repetição | Slide sincronizado em tempo real |
| Navegação por botões, teclado (← → espaço), toque e deslizar | Tela cheia (botão, tecla **F** ou duplo clique) |
| Tela cheia com controles flutuantes | Aviso quando a apresentação é encerrada |
| Contador de pessoas assistindo | Layout responsivo (celular, tablet, PC, projetor) |
| Botão para copiar o link de acesso | |
| Lista "Minhas apresentações" para retomar depois | |
| Cadastro (nome, sobrenome, nascimento, e-mail, senha e foto) | |
| Foto de perfil convertida e salva em **.webp** no banco | |
| Tela "Esqueci minha senha" | |
| Botão de perfil com opção **Sair** | |
| **Lápis** (6 cores) e **marca-texto** (6 cores) sobre o slide, com desfazer e limpar | Anotações aparecem ao vivo, no lugar certo em qualquer tamanho de tela |
| Encerrar e **liberar o download por 24 h**, ou encerrar e apagar na hora | Tela final com **QR Code**, link e botão **Baixar PDF** |
| Tela final com QR Code grande para o público escanear | Página de download: PDF **original** ou **com as anotações** |
| Lista mostra até quando o download fica disponível (com QR e link) | Contagem do tempo restante; link expira sozinho |
| Controle de mais de um dispositivo (ex.: notebook no projetor + celular como controle remoto) | |
| Apresentações vencidas são apagadas automaticamente | |

## Estrutura

```
├── index.html            # Página inicial: escolher Apresentação ou Administrador
├── assistir.html         # Visitante: digita o PIN e assiste
├── apresentador.html     # Apresentador: login, upload e controle
├── download.html         # Download do PDF (link/QR Code, válido por 24 h)
├── css/style.css         # Estilos (tema escuro, responsivo)
├── js/
│   ├── firebase-config.js  # ⚠️ suas chaves do Firebase vão aqui
│   ├── firebase.js         # Inicialização do Firebase
│   ├── common.js           # Funções compartilhadas
│   ├── account.js          # Login (e-mail/Google/Apple), cadastro, senha e perfil
│   ├── image.js            # Converte a foto de perfil para WebP
│   ├── protect.js          # Bloqueia botão direito, F12/inspecionar, copiar e imprimir
│   ├── pdf-render.js       # Renderização dos slides com PDF.js
│   ├── annotations.js      # Lápis/marca-texto e geração do PDF com anotações
│   ├── download.js         # Lógica da página de download
│   ├── vendor/qrcode.js    # Gerador de QR Code (sem depender de internet)
│   ├── viewer.js           # Lógica do visitante
│   └── presenter.js        # Lógica do apresentador
└── database.rules.json   # Regras de segurança do Realtime Database
```

### Como os dados ficam no banco

```
sessions/{PIN}           → dono, título, nº de páginas, slide atual, pronto?, encerrada?, expira em
annotations/{PIN}/{pág}  → traços de lápis/marca-texto (cor, espessura e pontos normalizados)
files/{PIN}/c0, c1, …    → o PDF em pedaços (base64)
viewers/{PIN}/{id}       → presença de cada visitante (some ao fechar a aba)
users/{uid}/profile      → nome, sobrenome, nascimento, e-mail e foto (.webp em base64)
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
2. Em **Método de login**, ative:
   - **E-mail/senha** (necessário para o cadastro e o "Esqueci minha senha");
   - **Google**: basta ativar e escolher o e-mail de suporte;
   - **Apple**: veja o passo 2.1.
3. Em **Configurações → Domínios autorizados**, adicione: `lferodrigues.github.io` (e o seu domínio próprio, se usar).
4. Em **Configurações → Ações do usuário**, deixe **Ativar criação (inscrição)** marcado, para o cadastro funcionar.
5. *(Opcional)* Em **Templates → Redefinição de senha**, mude o idioma para português.

#### 2.1. Login com Apple
O login com Apple exige uma conta no **Apple Developer Program** (paga). Com ela:
1. No [Apple Developer](https://developer.apple.com/account/resources), crie um **App ID** com *Sign in with Apple* e um **Services ID** (ex.: `net.feliperodrigues.apresentacao`).
2. No Services ID, configure *Sign in with Apple*: domínio `apresentacao-slides-4b2f9.firebaseapp.com` e URL de retorno `https://apresentacao-slides-4b2f9.firebaseapp.com/__/auth/handler`.
3. Crie uma **Key** com *Sign in with Apple* e baixe o arquivo `.p8`.
4. No Firebase, ative **Apple** e preencha o Services ID, o Team ID, o Key ID e o conteúdo da chave `.p8`.

Enquanto o Apple não estiver configurado, o botão mostra a mensagem "Este método de login ainda não foi ativado no Firebase".

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
1. Abra `https://lferodrigues.github.io/apresentacao/`, clique em **Administrador** e entre (e-mail, Google ou Apple). Na primeira vez, use **Cadastre-se**. Quem entra pelo Google ou pela Apple completa o cadastro (data de nascimento e foto) no primeiro acesso.
2. Escolha o PDF, dê um título e clique em **Enviar e gerar PIN**.
3. Mostre o PIN (ou envie o link) para o público.
4. Navegue com **← →**, **espaço**, os botões, tocando nas laterais do slide ou deslizando o dedo. **F** = tela cheia.
5. **Anotações:** na barra sobre o slide, escolha o **lápis** (tecla **P**) ou o **marca-texto** (tecla **H**) e a cor, e desenhe com o mouse, a caneta ou o dedo. **Ctrl+Z** desfaz; a lixeira limpa o slide; **Esc** (ou a seta da barra) volta ao modo de navegação. Cada slide guarda as próprias anotações.
6. Ao terminar, clique em **Encerrar** e escolha:
   - **Encerrar e liberar o download por 24 horas**: todas as telas mostram o QR Code e o link para baixar o PDF;
   - **Encerrar e apagar agora**: o arquivo é apagado na hora.
7. Em **Minhas apresentações**, as encerradas mostram até quando o download vale, com os botões **QR e link de download**, **Reabrir** e **Excluir**.

**Visitante**
1. Abra `https://lferodrigues.github.io/apresentacao/` e clique em **Apresentação** (ou abra direto `.../assistir.html`).
2. Digite o PIN e clique em **Assistir**.
3. Quando o apresentador encerrar, aparece a tela com o **QR Code** e o botão **Baixar PDF**. Na página de download dá para escolher o PDF **original** ou **com as anotações**. O link vale por 24 horas.

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
- **Proteção:** o botão direito, o F12, os atalhos do inspecionar (Ctrl+Shift+I/J/C, Cmd+Option+I no Mac), Ctrl+U, salvar, imprimir e copiar ficam bloqueados. Isso barra o uso comum, mas nenhum site consegue impedir 100% o acesso às ferramentas do desenvolvedor (por exemplo, pelo menu do navegador).
- **Download por 24 h:** o prazo é conferido pelas regras do banco com a hora do servidor, então depois de 24 h ninguém mais consegue baixar, mesmo com o link. O plano gratuito não tem tarefas agendadas: os arquivos vencidos são apagados quando o apresentador abre o painel ou quando o PIN é reutilizado.
- **PDF com anotações:** é montado no navegador de quem baixa, com a biblioteca pdf-lib (carregada da CDN jsDelivr). Se algo falhar, o PDF original é baixado.
- **Foto de perfil:** é recortada em quadrado, reduzida para 320×320 px e salva como WebP (normalmente 10–40 KB) direto no Realtime Database, sem precisar do Firebase Storage.
- **iPhone:** o Safari não tem tela cheia "de verdade" para páginas; o sistema usa um modo que ocupa a tela toda.
- Para restringir o envio a **um único usuário**, troque nas regras `auth != null` por `auth.uid === 'SEU_UID'` (o UID aparece na aba Usuários do Authentication).

## Tecnologias

- [Firebase](https://firebase.google.com) — Authentication e Realtime Database (SDK modular 10.12, via CDN)
- [PDF.js](https://mozilla.github.io/pdf.js/) 4.4 — renderização dos slides
- [pdf-lib](https://pdf-lib.js.org/) 1.17 — PDF com anotações
- QRCode for JavaScript (Kazuhiko Arase, licença MIT), empacotado em `js/vendor/qrcode.js`
- HTML, CSS e JavaScript puros (sem build)

---

Desenvolvido por **[feliperodrigues.net](https://feliperodrigues.net)**
