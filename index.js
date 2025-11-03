import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

//  CONFIGS
dotenv.config();
const { EVOLUTION_API_URL, EVOLUTION_API_TOKEN, PORT, DIRECTUS_API_URL, DIRECTUS_API_TOKEN } = process.env;

export const evoApi = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    "Content-Type": "application/json",
    apikey: EVOLUTION_API_TOKEN
  },
});

export const directusApi = axios.create({
  baseURL: DIRECTUS_API_URL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DIRECTUS_API_TOKEN}`
  },
});

//  MIDDLEWARES
const getUserMiddleware = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.split(" ")[1];

    if(!token) {
      return res.status(404).send({ message: "Token não enviado." })
    }

    const response = await directusApi.get("/users/me", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    const user = response.data.data

    if(!user) {
      return res.status(404).send({ message: "Usuário não encontrado." })
    }

    req.user = user;

    next();
  } catch (error) {
    return res.status(401).send({ message: "UNAUTHORIZED" })
  }
}

//  UTILS
const generateRandomString = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

//  MODELS
const createInstanceModel = async (payload) => {
  // const { type, evolution_id, user_id } = payload;
  const response =  await directusApi.post("/items/instances", payload)

  return response.data.data
}

const updateInstanceModel = async (id, data) => {
  // const { type, evolution_id, user_id } = payload;
  const response = await directusApi.post(`/items/instances/${id}`, data)

  return response.data.data
}

const getInstanceByUserIdModel = async (userId) => {
  const response = await directusApi.get(`/items/instances`, {
    params: {
      filter: {
        user_id: {
          _eq: userId
        }
      }
    }
  })

  return response.data.data
}

const getInstanceByEvolutionIdModel = async (id) => {
  const response = await directusApi.get(`/items/instances`, {
    params: {
      filter: {
        evolution_id: {
          _eq: id
        }
      }
    }
  })

  return response.data.data
}

const createChatHistorieModel = async (payload) => {
  const response = await directusApi.post(`/items/chat_histories`, payload)

  return response.data.data
}

//  SERVICES
//  EVOLUTION SERVIES
const createInstance = async (instanceName) => {

  const payload = {
    instanceName,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    //webhook: `http://localhost:4000/webhook/agents`,
    //webhook_by_events: true,
    //events: [
      //"MESSAGES_UPSERT",
    //]
  }

  const instance = await evoApi.post(`/instance/create`, payload);

  await evoApi.post(`webhook/set/${instanceName}`, {
    webhook: {
      url: `http://localhost:5000/evolution/webhooks`,
      events: [
        "CONNECTION_UPDATE",
        "LOGOUT_INSTANCE",
        "MESSAGES_UPSERT",
        "QRCODE_UPDATED",
        "REMOVE_INSTANCE",
      ],
      enabled: true,
      webhookByEvents: false,
      webhookBase64: false,
      instanceId: instance.data.instance.instanceId,
    }
  });

  return instance;
}

const connectInstance = async (id) => {
  return await evoApi.get(`/instance/connect/${id}`)
}

// ROUTERS SERVICES
const getQrCodeToConnect = async (userId) => {
  const instanceResponse = await getInstanceByUserIdModel(userId);
  
  const instance = instanceResponse[0];
  
  
  if(!instance) {
    const randomId = generateRandomString();
    const { data } = await createInstance(randomId);
    
    await createInstanceModel({
      type: "whatsapp",
      evolution_id: randomId,
      user_id: userId
    })
    
    return data.qrcode;
  }
  
  if(instance.is_connected) throw new Error("Você já está conectado ao whatsapp.");
  
  const response = await connectInstance(instance.evolution_id);
  
  return response.data;
}

const connectionUpdate = async (instanceId, data) => {
  const instance = await getInstanceByEvolutionIdModel(instanceId);
  
  if (!instance) return;

  await updateInstanceModel(instance.id, {
    is_connected: Boolean(data.state === "open"),
    name: data?.wuid?.replace("@s.whatsapp.net", "")  ?? null,
  });
}

const logoutInstance = async (instanceId) => {
  const instance = await getInstanceByEvolutionIdModel(instanceId);
  
  if (!instance) return;

  return await updateInstanceModel(instance.id, { is_connected: false });
}

const removeInstance = async (instanceId) => {
  const instance = await getInstanceByEvolutionIdModel(instanceId);
  
  if (!instance) return;

  return await updateInstanceModel(instance.id, { is_connected: false, evolution_id: null, name: null });
}

const upsertMessage = async (instanceId, data) => {
  const instance = await getInstanceByEvolutionIdModel(instanceId);
  
  if (!instance) return;

  // if(instance.is_disable) return;

  const message = data.message.conversation;

  const remoteJid = data.key.remoteJid;

  const isFromMe = data.key.fromMe;
  
  const [ number, type ] = remoteJid.split("@");
  
  if(type !== "s.whatsapp.net") return;

  // if(data.messageType !== "conversation") {
  //   evoApi.post(`/message/sendText/${instanceId}`, { number, text: `Peço desculpas, não consigo entender mensagens desse tipo. Por favor, envie uma mensagem de texto.` });
  //   return;
  // }

  if(isFromMe) {
    await createChatHistorieModel({
      agent_id: agent.id,
      chat_id: remoteJid,
      instance_id: instance.id,
      role: "assistant",
      content: message,
      isFromHuman: true,
    });

    return;
  }

  await createChatHistorieModel({
    agent_id: agent.id,
    chat_id: remoteJid,
    instance_id: instance.id,
    role: "user",
    content: message,
  });


  //PARTE DO AGENTE DE IA
  
  // const responseText = await getAgentResponse(agent.id, remoteJid, message, instanceId);

  // evolutionsService.sendMessage({ instanceId, number: remoteJid, text: responseText ?? "TXT empty" });

  // await createChatHistorieModel({
  //   agent_id: agent.id,
  //   chat_id: remoteJid,
  //   instance_id: instance.id,
  //   role: "assistant",
  //   content: responseText,
  // });
}

const distribuition = async (event, instance, data) => {
  try {
    switch (event) {
      case "connection.update":
        await connectionUpdate(instance, data);
        break;
  
      case "logout.instance":
        await logoutInstance(instance);
        break;
  
      case "remove.instance":
        await removeInstance(instance);
        break;
  
      case "messages.upsert":
        await upsertMessage(instance, data);
        break;
  
      default:
        break;
      }
    } catch (error) {
      console.warn(`Unhandled event: ${event} for instance ${instance}`);
  }
}

const app = express();

app
.use(express.json())
.use(cors())
.get("/health", (req, res) => {
  return res.send({
    timestamp: new Date().getTime(),
    status: "running"
  })
})
.post("/evolution/webhooks", (req, res, next) => {
  try {
    const { event, instance, data } = req.body;
  
    distribuition(event, instance, data);
  
    return res.status(200).send({ message: "OK" });
  } catch (error) {
    next(error);
  }
})

.get("/whatsapp/connect", getUserMiddleware, async (req, res, next) => {
  try {
    const instance = await getQrCodeToConnect(req.user.id)

    return res.send(instance);
  } catch (error) {
    next(error);
  }
})

.use((error, req, res, next) => {
  console.log("HANDLER ERRORS", error);
  return res.status(error.status ?? 400).send({
    message: error.message ?? "Erro ao processar requisição",
  });
})

.listen(Number(PORT) ?? 5000, () => console.log(`API running on PORT: ${Number(PORT) ?? 5000}`));