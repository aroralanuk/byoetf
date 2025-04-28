import { openai } from "@ai-sdk/openai";
import { streamText, experimental_createMCPClient, tool } from "ai";
// Import the Stdio transport
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "ai/mcp-stdio";
import { z } from "zod";
import {
  generateEtfHoldingsTool,
  calculateEtfPerformanceTool,
} from "../../lib/etfTools";

// Allow responses up to 5 minutes
export const maxDuration = 300;

// Schema for the parameters of the calvernaz/alphavantage `getTimeSeriesDailyAdjusted` tool
// (Assuming standard Alpha Vantage parameters)
const AlphaVantageParamsSchema = z.object({
  symbol: z
    .string()
    .describe("The stock symbol to fetch data for (e.g., 'IBM')."),
  outputsize: z
    .enum(["compact", "full"])
    .default("compact")
    .optional()
    .describe("compact (~100 days) or full."),
});

// Define the MCP tool schemas targeting the calvernaz implementation
const alphaVantageMCPToolSchemas = {
  // Assuming tool name based on common function, verify if different in calvernaz server
  time_series_daily: {
    description:
      "Fetches daily adjusted time series data for a given stock symbol.",
    parameters: z.object({
      symbol: z.string(),
      prices: z.array(z.object({ date: z.string(), price: z.number() })),
    }),
    // Defining a loose result schema as the exact nested map is hard to Zod parse
    // The adapter function will handle the actual structure.
    result: z.record(z.string(), z.any()).optional(), // Loosely expect a record/map
  },
};

export async function POST(req: Request) {
  const { messages } = await req.json();

  let mcpClient;

  try {
    // --- MCP Client Setup using Stdio ---
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    const mcpServerDir = "/Users/kunalarora/dev/ai/alphavantage/";
    const mcpServerCommand = "alphavantage";

    if (!apiKey) {
      console.warn("ALPHAVANTAGE_API_KEY environment variable not set...");
    } else {
      try {
        console.log(`Attempting to start MCP server via Stdio...`);
        mcpClient = await experimental_createMCPClient({
          transport: new StdioMCPTransport({
            command: "uv",
            args: ["--directory", mcpServerDir, "run", mcpServerCommand],
            env: { ALPHAVANTAGE_API_KEY: apiKey },
          }),
        });
        console.log(`MCP Client created via Stdio`);
      } catch (mcpError) {
        console.error("Failed to initialize MCP Client via Stdio:", mcpError);
        mcpClient = undefined;
      }
    }

    // --- Tool Definition ---
    let mcpTools: Record<string, any> = {};
    // Define allTools initially with local tools
    const allTools: Record<string, any> = {
      generateEtfHoldings: generateEtfHoldingsTool,
      calculateEtfPerformance: calculateEtfPerformanceTool,
    };

    if (mcpClient) {
      try {
        mcpTools = await mcpClient.tools({
          schemas: alphaVantageMCPToolSchemas,
        });
        console.log("MCP Tools fetched:", Object.keys(mcpTools));
      } catch (mcpToolError) {
        console.error("Failed to get tools from MCP server:", mcpToolError);
        mcpTools = {};
      }
    }

    console.log("DEBUGmcpTools", mcpTools);
    const mcpTimeSeriesTool = mcpTools["time_series_daily"];
    if (mcpTimeSeriesTool && typeof mcpTimeSeriesTool.execute === "function") {
      // Add fetchStockHistory if MCP tool is available
      allTools.fetchStockHistory = tool({
        description: "Fetch historical daily adjusted closing prices...",
        parameters: AlphaVantageParamsSchema,
        execute: async (args: z.infer<typeof AlphaVantageParamsSchema>) => {
          const executionArgs = { ...args, outputsize: "compact" as const };
          console.log(`Calling MCP tool 'time_series_daily'...`);
          try {
            const result = await mcpTimeSeriesTool.execute(executionArgs);
            console.log(
              "MCP result with executionArgs:",
              executionArgs,
              result
            );
            return result;
          } catch (mcpError) {
            console.error("Error in 'fetchStockHistory' tool:", mcpError);
            throw new Error("Failed to fetch stock history.");
          }
        },
      });
      console.log("'fetchStockHistory' tool configured...");
    } else {
      console.warn("'fetchStockHistory' tool is unavailable...");
    }

    console.log("Final tools provided to AI:", Object.keys(allTools));

    console.log("messages", messages);
    // --- StreamText Call ---
    const resultStream = await streamText({
      model: openai("gpt-4o"),
      tools: allTools,
      maxSteps: 20,
      toolChoice: "auto",
      prompt: `User query: ${messages[messages.length - 1]?.content}
      You are an AI assistant helping users design ETFs.
      Follow these steps:
      1. Use 'generateEtfHoldings' with the user query to get holdings and ETF name.
      2. Check if the 'fetchStockHistory' tool is available. If yes, call it *sequentially* for *each* holding symbol from step 1. Use the default 'compact' outputsize.
      3. If price histories were fetched for all holdings, use 'calculateEtfPerformance' with the ETF name, holdings, and fetched price histories.
      4. Respond with the ETF name, holdings list (symbol, name, weight). 
      5. If performance was calculated, summarize it. If 'fetchStockHistory' was unavailable or failed for any symbol, state that performance could not be calculated due to missing/incomplete price data.`,
    });

    // --- Return Streaming Response ---
    // Important: We DO NOT close the MCP client here as it needs to remain open
    // for the duration of the streaming response to handle tool calls
    return resultStream.toDataStreamResponse();
  } catch (error) {
    console.error("Error in POST /api/chat:", error);
    // Close the MCP client on error
    if (mcpClient && typeof mcpClient.close === "function") {
      try {
        console.log("Closing MCP client after error...");
        await mcpClient.close();
      } catch (closeErr) {
        console.error("Error closing MCP client on error:", closeErr);
      }
    }
    return new Response(
      JSON.stringify({ error: "An internal server error occurred." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  // Removed the finally block that was closing the MCP client
  // The client needs to stay open for the duration of the streaming response
}
