import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

interface CallOpenAIParams {
  model?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
}

export async function callOpenAI(params: CallOpenAIParams): Promise<string> {
  const {
    model = "gpt-4o",
    messages,
    temperature = 0.2,
    max_tokens = 4096,
    response_format,
  } = params;

  const response = await openai.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens,
    ...(response_format && { response_format }),
  });

  return response.choices[0]?.message?.content || "";
}
