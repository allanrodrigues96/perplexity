// api/alexa.js
// Handler robusto para Alexa em Vercel/Node 18+
// - LaunchRequest: "abrir ajudante inteligente"
// - IntentRequest: AskPerplexityIntent (slot 'query'), com fallback p/ intents padrão
// - Chama MAKE_WEBHOOK_URL (POST { query }) e aceita vários formatos de retorno
// - Verificação opcional de assinatura via ALEXA_VERIFY
// - Sanitiza SSML e trata erros com respostas amigáveis

import verifier from "alexa-verifier";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// --------- Helpers ---------
function ssmlEscape(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function alexaSpeech(ssmlText, { end = false, reprompt = "Quer perguntar mais alguma coisa?" } = {}) {
  const response = {
    version: "1.0",
    response: {
      shouldEndSession: end,
      outputSpeech: { type: "SSML", ssml: `<speak>${ssmlEscape(ssmlText)}</speak>` }
    }
  };
  if (!end && reprompt) {
    response.response.reprompt = { outputSpeech: { type: "PlainText", text: reprompt } };
  }
  return response;
}

function getRawBody(req) {
  // Necessário para verificação de assinatura da Alexa
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Extrai melhor query possível, cobrindo intents/slots padrão
function extractQuery(alexaReq) {
  const slots = alexaReq?.request?.intent?.slots || {};
  // Nome do nosso slot personalizado
  if (slots.query?.value) return String(slots.query.value);

  // Alguns modelos criam slot AMAZON.SearchQuery com outros nomes
  for (const k of Object.keys(slots)) {
    if (slots[k]?.name && /query/i.test(slots[k].name) && slots[k].value) {
      return String(slots[k].value);
    }
    if (slots[k]?.resolutions?.resolutionsPerAuthority) {
      const val = slots[k].value;
      if (val) return String(val);
    }
  }

  // Fallbacks comuns
  const intentName = alexaReq?.request?.intent?.name || "";
  if (/AMAZON\.SearchIntent/i.test(intentName)) {
    // alguns modelos usam 'AMAZON.SearchIntent' + slot 'SearchQuery' / 'query'
    for (const k of Object.keys(slots)) {
      if (slots[k]?.value) return String(slots[k].value);
    }
  }

  return "";
}

// --------- Handler principal ---------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const rawBody = await getRawBody(req);

    // Verificação de assinatura (desligue com ALEXA_VERIFY = "false")
    try {
      if (process.env.ALEXA_VERIFY !== "false") {
        const signature = req.headers["signature"];
        const certUrl = req.headers["signaturecertchainurl"];
        await verifier(certUrl, signature, rawBody);
      }
    } catch (e) {
      console.error("Assinatura inválida:", e);
      // Por segurança, 200 com resposta de fim de conversa
      return res.status(200).json(
        alexaSpeech("Não foi possível validar a requisição.", { end: true })
      );
    }

    // Parse do request Alexa
    let alexaReq;
    try {
      alexaReq = JSON.parse(rawBody.toString("utf8"));
    } catch (e) {
      console.error("Falha ao parsear body da Alexa:", e);
      return res.status(200).json(alexaSpeech("Requisição inválida.", { end: true }));
    }

    const type = alexaReq?.request?.type;
    const intent = alexaReq?.request?.intent?.name || "";
    console.log("Alexa type/intent:", type, intent);

    // 1) LaunchRequest
    if (type === "LaunchRequest") {
      return res.status(200).json(
        alexaSpeech("Oi! O que você quer saber?")
      );
    }

    // 2) IntentRequest -> AskPerplexityIntent (ou fallback p/ modelos semelhantes)
    if (type === "IntentRequest" && (/AskPerplexityIntent/i.test(intent) || /SearchIntent/i.test(intent) || /Query/i.test(intent))) {
      const query = extractQuery(alexaReq);
      if (!query) {
        return res.status(200).json(
          alexaSpeech("Qual é a sua pergunta?", { end: false })
        );
      }

      if (!MAKE_WEBHOOK_URL) {
        console.error("MAKE_WEBHOOK_URL não configurada");
        return res.status(200).json(
          alexaSpeech("Configuração ausente. Tente novamente mais tarde.", { end: true })
        );
      }

      // Chamada ao Make
      let makeResp;
      try {
        makeResp = await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query })
        });
      } catch (e) {
        console.error("Erro de rede ao chamar Make:", e);
        return res.status(200).json(
          alexaSpeech("Tive um problema de conexão ao buscar a resposta.", { end: true })
        );
      }

      const text = await makeResp.text();
      console.log("MAKE status:", makeResp.status);

      // Tenta como JSON:
      let payload = null;
      try { payload = JSON.parse(text); } catch {}

      // Se o Make já devolveu um JSON Alexa válido, devolvemos direto
      if (payload?.version && payload?.response) {
        return res.status(200).json(payload);
      }

      // Se veio { text: "..." } ou string pura, converte para fala
      const answer = payload?.text || text || "";
      if (!answer.trim()) {
        return res.status(200).json(
          alexaSpeech("Não encontrei uma resposta no momento.", { end: false })
        );
      }

      return res.status(200).json(
        alexaSpeech(answer, { end: false })
      );
    }

    // 3) Fallback para qualquer outra coisa
    return res.status(200).json(
      alexaSpeech("Desculpe, não entendi.", { end: false })
    );
  } catch (err) {
    console.error("Erro não-capturado:", err);
    return res.status(200).json(
      alexaSpeech("Desculpe, houve um erro ao processar.", { end: true })
    );
  }
}

/**
 * Se estiver usando Next.js Pages API, desative o bodyParser
 * para que possamos ler o corpo bruto (raw) e validar a assinatura.
 * Em Vercel sem Next, isso é ignorado sem problemas.
 */
export const config = {
  api: { bodyParser: false }
};
