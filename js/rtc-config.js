// =====================================================================
//  SERVIDORES DE CONEXÃO (WebRTC)
//  STUN: descobre o endereço público de cada aparelho (gratuito).
//  TURN: retransmite o vídeo quando a rede bloqueia a conexão direta
//        (algumas redes corporativas, de escolas e 4G/5G). Opcional, mas
//        recomendado. Veja o README para obter um gratuito.
// =====================================================================
export const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },

  // Exemplo de TURN (descomente e preencha):
  // {
  //   urls: ["turn:SEU-SERVIDOR:3478", "turns:SEU-SERVIDOR:5349"],
  //   username: "USUARIO",
  //   credential: "SENHA",
  // },
];

// Qualidade do vídeo enviado para cada pessoa
export const VIDEO = {
  screen: { maxBitrate: 2_500_000, maxFramerate: 30, width: 1920, height: 1080 },
  camera: { maxBitrate: 1_500_000, maxFramerate: 30, width: 1280, height: 720 },
};
