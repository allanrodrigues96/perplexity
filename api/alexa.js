// api/alexa.js
// ESM (package.json: { "type": "module" })
import verifier from "alexa-verifier";

/**
 * Lê o corpo cru (string) SEM parsear JSON nem alterar espaços.
 * Isso é crucial para a validação de assinatura da Alexa.
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Respostas utilitárias
 */
function alexaResponseSSML(ssml, shouldEndSession = true) {
  return {
    version: "1.0",
    response: {
      shouldEndSession,
      outputSpeech: { type: "SSML", ssml },
    },
  };
}

function alexaResponsePlain(text, shouldEndSession = true) {
  return {
    version: "1.0",
    response: {
      shouldEndSession,
      outputSpeech: { type: "PlainText", text },
    },
  };
}

/**
 * Handler principal (Vercel Serverless / Node runtime)
 */
export default async function handler(req, res) {
  try {
    // Só aceitamos POST
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // Lê o corpo cru primeiro (sem JSON.parse)
    const rawBody = await readRawBody(req);

    // Headers que a Alexa envia (Vercel normaliza para lower-case)
    const signature = req.headers["signature"];
    const certUrl = req.headers["signaturecertchainurl"];

    // Flag para ativar/desativar verificação (em produção deixe true)
    const VERIFY = String(process.env.ALEXA_VERIFY || "true").toLowerCase() === "true";

    if (VERIFY) {
      if (!signature || !certUrl) {
        console.error("Faltam headers de verificação", { signature: !!signature, certUrl: !!certUrl });
        return res
          .status(401)
          .json(alexaResponseSSML("<speak>Não foi possível validar a requisição.</speak>"));
      }

      // Validação da assinatura
      await new Promise((resolve, reject) => {
        verifier(certUrl, signature, rawBody, (err) => (err ? reject(err) : resolve()));
      });
    }

    // Agora sim podemos parsear o JSON
    let alexaReq;
    try {
      alexaReq = JSON.parse(rawBody);
    } catch (e) {
      console.error("JSON inválido recebido da Alexa:", e?.message);
      return res
        .status(400)
        .json(alexaResponseSSML("<speak>Desculpe, houve um erro ao processar.</speak>"));
    }

    // Roteamento básico por tipo
    const type = alexaReq?.request?.type;
    const intentName = alexaReq?.request?.intent?.name;

    // 1) Abertura da skill
    if (type === "LaunchRequest") {
      return res.status(200).json(
        alexaResponseSSML(
          "<speak>Oi! O que você quer saber?</speak>",
          /* shouldEndSession */ false
        )
      );
    }

    // 2) Intent principal
    if (type === "IntentRequest" && intentName === "AskPerplexityIntent") {
      const query =
        alexaReq?.request?.intent?.slots?.query?.value?.trim() ||
        alexaReq?.request?.intent?.slots?.SearchQuery?.value?.trim() ||
        "";

      if (!query) {
        return res
          .status(200)
          .json(
            alexaResponseSSML(
              "<speak>Qual é a sua dúvida?</speak>",
              /* shouldEndSession */ false
            )
          );
      }

      // Chama seu cenário no Make (ou qualquer webhook)
      const url = process.env.MAKE_WEBHOOK_URL;
      if (!url) {
        console.error("MAKE_WEBHOOK_URL ausente");
        return res
          .status(500)
          .json(alexaResponseSSML("<speak>Erro de configuração do servidor.</speak>"));
      }

      // Você pode mandar só { query } e montar a resposta no Make
      // ou já devolver Alexa JSON pronto pelo próprio Make.
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      // Se seu Make devolver o objeto Alexa já pronto, apenas retransmita:
      // Caso contrário, adapte aqui para converter sua resposta em SSML.
      let makeJson;
      try {
        makeJson = await r.json();
      } catch {
        makeJson = null;
      }

      if (makeJson && makeJson.version && makeJson.response) {
        return res.status(200).json(makeJson);
      }

      // Fallback: texto simples vindo do Make?
      const text =
        (makeJson && (makeJson.text || makeJson.message || makeJson.answer)) ||
        "Desculpe, não encontrei a resposta.";

      return res.status(200).json(
        alexaResponseSSML(
          `<speak>${String(text)}</speak>`,
          /* shouldEndSession */ true
        )
      );
    }

    // 3) Encerramento
    if (type === "SessionEndedRequest") {
      return res.status(200).json(alexaResponsePlain("Tchau!", true));
    }

    // Caso não reconheça
    return res
      .status(200)
      .json(alexaResponseSSML("<speak>Desculpe, não entendi.</speak>", true));
  } catch (err) {
    // Qualquer exceção cai aqui
    console.error("Falha no handler:", err?.message || err);
    return res
      .status(500)
      .json(alexaResponseSSML("<speak>Desculpe, houve um erro ao processar.</speak>"));
  }
}
