import Fastify from "fastify";
import websocket from "@fastify/websocket";
import formBody from "@fastify/formbody";
import dotenv from "dotenv";
import { handleStream } from "./stream-handler.js";

dotenv.config();

const fastify = Fastify({
  logger: true,
});

// Register plugins
fastify.register(formBody);
fastify.register(websocket);

// Root route
fastify.get("/", async (request, reply) => {
  return { message: "Twilio Media Stream Server is running!" };
});

// Route for Twilio to handle incoming calls (or outbound callbacks)
// This returns TwiML to tell Twilio to connect to the Media Stream
fastify.all("/voice", async (request, reply) => {
  const twiml = `
    <Response>
        <Say>Connecting you to the AI sales agent.</Say>
        <Connect>
            <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
    </Response>
  `;

  reply.type("text/xml").send(twiml);
});

// WebSocket route for the Media Stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected to media stream");
    handleStream(connection, req);
  });
});

const PORT = process.env.PORT || 5050;

const start = async () => {
  try {
    await fastify.listen({ port: Number(PORT), host: "0.0.0.0" });
    console.log(`Server listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
