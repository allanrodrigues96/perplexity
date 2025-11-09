import verifier from "alexa-verifier";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// Util: escapa texto para SSML/JSON seguro
function toSafeSsml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;"); // aspas duplas podem ficar; JSON vai escapar
}

function alexaSpeechResponse(ssmlText, { end = false } = {}) {
  return {
    version: "1.0",
    response: {
      shouldEndSession: end,
      outputSpeech: {
        type: "SSML",
        ssml: `<speak>${toSafeSsml(ssmlText)}</speak>`
      },
      reprompt: end
        ? undefined
        : { outputSpeech: { type: "PlainText", text: "Quer perguntar mais alguma coisa?" } }
    }
  };
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await getRawBody(req);
  const signature = req.headers["signature"] || req.headers["signaturecertchainurl"] ? req.headers["signature"] : req.headers["signature"]; // só pra manter compatível
  const certUrl = req.headers["signaturecertchainurl"];

  try {
    // 1) Verifica a assinatura (se quiser desabilitar temporariamente, comente esta linha)
    if (process.env.ALEXA_VERIFY !== "false") {
      await verifier(certUrl, signature, rawBody);
    }

    // 2) Parse do request da Alexa
    let alexaReq;
    try {
      alexaReq = JSON.parse(rawBody.toString("utf8"));
    } catch (e) {
      console.error("Falha ao parsear body da Alexa:", e);
      return res.status(400).json(alexaSpeechResponse("Requisição inválida.", { end: true }));
    }

    const type = alexaReq.request?.type;
    const intent = alexaReq.request?.intent?.name;
    const query =
      alexaReq.request?.intent?.slots?.query?.value ||
      alexaReq.request?.intent?.slots?.anyQuery?.value || // caso crie outro slot
      "";

    // 3) LaunchRequest
    if (type === "LaunchRequest") {
      return res.status(200).json(
        alexaSpeechResponse("Oi! O que você quer saber?")
      );
    }

    // 4) IntentRequest principal
    if (type === "IntentRequest" && intent === "AskPerplexityIntent") {
      // Envie para o Make
      const r = await fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });

      const text = await r.text(); // <-- SEMPRE texto
      let payload = null;
      let answer = null;

      try {
        payload = JSON.parse(text);
      } catch (e) {
        // O Make não devolveu JSON válido — vamos tratar como texto puro
        console.warn("Make retornou texto não-JSON. Usando como resposta bruta.");
      }

      // 5) Extrai a resposta
      // Opção A: o Make devolve o próprio JSON Alexa (version/response/...)
      if (payload?.version && payload?.response) {
        return res.status(200).json(payload);
      }

      // Opção B: o Make devolve { "text": "..." } (recomendado)
      if (payload?.text) {
        answer = payload.text;
      }

      // Opção C: o Make devolveu texto puro
      if (!answer && text) {
        answer = text;
      }

      if (!answer) {
        console.error("Resposta do Make vazia ou inválida:", text);
        return res.status(200).json(
          alexaSpeechResponse("Desculpe, houve um erro ao processar sua pergunta.", { end: true })
        );
      }

      // 6) Entrega a resposta como SSML
      return res.status(200).json(
        alexaSpeechResponse(answer)
      );
    }

    // 7) Fallback
    return res.status(200).json(
      alexaSpeechResponse("Desculpe, não entendi.", { end: false })
    );
  } catch (err) {
    console.error("Erro no handler:", err);
    return res.status(200).json(
      alexaSpeechResponse("Desculpe, houve um erro ao processar.", { end: true })
    );
  }
}
