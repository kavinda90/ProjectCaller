import twilio from "twilio";
import dotenv from "dotenv";
import readline from "readline";

dotenv.config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const serverDomain = process.env.SERVER_DOMAIN; // e.g., 'abcdef.ngrok.io'

if (!accountSid || !authToken || !fromNumber || !serverDomain) {
  console.error("Missing environment variables. Please check .env");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

// Simple CLI interaction
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const makeCall = async (toNumber: string) => {
  try {
    console.log(`Initiating call to ${toNumber}...`);
    const call = await client.calls.create({
      url: `https://${serverDomain}/voice`, // This hits our Fastify route which returns TwiML
      to: toNumber,
      from: fromNumber,
      // statusCallback: `https://${serverDomain}/status`,
      // statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
    console.log(`Call Initiated! SID: ${call.sid}`);
  } catch (error) {
    console.error("Error making call:", error);
  }
};

rl.question(
  "Enter phone number to call (E.164 format, e.g., +15551234567): ",
  (number) => {
    makeCall(number.trim()).then(() => {
      rl.close();
    });
  }
);
