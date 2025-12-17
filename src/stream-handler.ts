import WebSocket from "ws";
import { SYSTEM_MESSAGE, TOOLS } from "./agent-config.js";

// OpenAI Realtime API Configuration
const OPENAI_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

export const handleStream = (connection: any, req: any) => {
  // Access key logic here to ensure env vars are loaded
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY in environment variables");
    connection.socket?.close(); // Safe close
    return;
  }

  console.log("Connection object keys:", Object.keys(connection));
  // In some configurations, 'connection' is the actual WebSocket, not the SocketStream wrapper
  const ws = connection.socket || connection;
  console.log("WS object:", ws ? "Defined" : "Undefined");
  if (!ws || !ws.on) {
    console.error("No WebSocket found on connection object");
    return;
  }
  let streamSid: string | null = null;
  let openAiWs: WebSocket | null = null;

  console.log("Incoming Media Stream connection");

  // Connect to OpenAI Realtime API
  try {
    openAiWs = new WebSocket(OPENAI_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
  } catch (error) {
    console.error("Error connecting to OpenAI:", error);
    ws.close();
    return;
  }

  // State for coordination
  let isOpenAIConnected = false;
  let isTwilioStarted = false;
  let hasGreeted = false;
  const sendInitialGreeting = () => {
    if (isOpenAIConnected && isTwilioStarted && !hasGreeted) {
      console.log("Both connections ready, sending initial greeting...");
      hasGreeted = true;

      const initialGreeting = {
        type: "response.create",
        response: {
          modalities: ["text", "audio"],
          instructions:
            "Greet the user with 'Hello? Is this the manager?'. Do not wait for them to speak first.",
        },
      };
      openAiWs?.send(JSON.stringify(initialGreeting));
    }
  };

  // --- OpenAI WebSocket Event Handlers ---

  openAiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime API");
    isOpenAIConnected = true;

    // 1. Initialize Session
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy", // or 'shimmer', 'echo'
        instructions: SYSTEM_MESSAGE,
        modalities: ["text", "audio"],
        temperature: 0.8,
        tools: TOOLS,
        tool_choice: "auto",
      },
    };
    openAiWs?.send(JSON.stringify(sessionUpdate));

    // Try to greet
    sendInitialGreeting();
  });

  openAiWs.on("message", (data: any) => {
    try {
      const response = JSON.parse(data.toString());

      // Log interesting events
      const ignoredEvents = [
        "response.audio.delta",
        "input_audio_buffer.append",
        "rate_limits.updated",
      ];
      if (!ignoredEvents.includes(response.type)) {
        // Log full error if failed
        if (
          response.type === "response.done" &&
          response.response.status === "failed"
        ) {
          console.error(
            "OpenAI Response Failed:",
            JSON.stringify(response.response)
          );
        } else {
          console.log(
            "OpenAI Event:",
            response.type,
            JSON.stringify(response).substring(0, 200)
          );
        }
      }

      if (response.type === "response.function_call_arguments.done") {
        console.log("Function called:", response);
        handleFunctionCall(response, openAiWs);
      }

      if (response.type === "response.audio.delta" && response.delta) {
        // Audio from OpenAI -> Send to Twilio
        if (streamSid) {
          const mediaMessage = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: response.delta, // OpenAI sends base64 G711_ULAW if configured
            },
          };
          ws.send(JSON.stringify(mediaMessage));
        }
      }

      // Handle Interruption / Barge-In
      if (response.type === "input_audio_buffer.speech_started") {
        console.log("Speech started detected - Clearing Twilio Buffer");
        if (streamSid) {
          const clearMessage = {
            event: "clear",
            streamSid: streamSid,
          };
          ws.send(JSON.stringify(clearMessage));
        }

        // Optional: Cancel OpenAI response generation if currently generating
        // (Server VAD handles input handling, but we might want to stop output generation explicitly if needed,
        // though `clear` on Twilio is the most critical for user experience)
      }
    } catch (e) {
      console.error("Error parsing OpenAI message:", e);
    }
  });

  openAiWs.on("error", (error: any) => {
    console.error("OpenAI WebSocket error:", error);
  });

  openAiWs.on("close", (code, reason) => {
    console.log(
      `OpenAI WebSocket closed with code: ${code} and reason: ${reason.toString()}`
    );
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  // --- Twilio WebSocket Event Handlers ---

  ws.on("message", (message: any) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "start") {
        console.log("Media Stream Start Payload:", JSON.stringify(data));
        streamSid = data.start.streamSid;
        isTwilioStarted = true;
        console.log(`Media Stream started: ${streamSid}`);
        sendInitialGreeting();
      } else if (data.event === "media") {
        // Audio from Twilio -> Send to OpenAI
        if (openAiWs?.readyState === WebSocket.OPEN) {
          const audioAppend = {
            type: "input_audio_buffer.append",
            audio: data.media.payload, // Twilio sends base64 G711_ULAW
          };
          openAiWs.send(JSON.stringify(audioAppend));
        }
      } else if (data.event === "stop") {
        console.log("Media Stream stopped");
        if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
      }
    } catch (error) {
      console.error("Error parsing Twilio message:", error);
    }
  });

  ws.on("close", () => {
    console.log("Twilio WebSocket closed");
    if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
  });
};

function handleFunctionCall(event: any, openAiWs: WebSocket | null) {
  // Extract function details
  // Note: Usage depends on specific event structure.
  // For 'response.function_call_arguments.done', we usually get call_id, name, arguments

  // Realtime API tool calling is distinct. The 'response.output_item.done' or similar events contain the call info.
  // Actually, 'response.function_call_arguments.done' gives us the args.
  // We need to send 'conversation.item.create' with the tool output.

  const { call_id, name, arguments: args } = event;
  console.log(`Executing tool: ${name} with args: ${args}`);

  if (name === "book_appointment") {
    const parsedArgs = JSON.parse(args);
    console.log(
      `Booking appointment for ${parsedArgs.prospect_name} at ${parsedArgs.time} on ${parsedArgs.date}`
    );

    // Send result back to OpenAI
    const toolOutput = {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: call_id,
        output: JSON.stringify({
          success: true,
          message:
            "Appointment booked successfully. Confirmation sent via email.",
        }),
      },
    };

    openAiWs?.send(JSON.stringify(toolOutput));

    // Trigger a response to acknowledge
    openAiWs?.send(JSON.stringify({ type: "response.create" }));
  }
}
