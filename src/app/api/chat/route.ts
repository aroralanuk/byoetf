import { openai } from "@ai-sdk/openai";
import {
  streamText,
  experimental_createMCPClient,
  // Correct import for MCPClient type might depend on exact AI SDK version,
  // using 'any' temporarily if direct type import fails
  type MCPClient as MCPClientType,
  type StreamTextResult,
  tool,
  generateText,
} from "ai"; // Added tool back for potential use, check if needed
import { z } from "zod";
import {
  generateEtfHoldingsTool,
  calculateEtfPerformanceTool,
} from "../../lib/etfTools";

// Allow responses up to 5 minutes
export const maxDuration = 300;

// Define the expected parameter schema for the Alpha Vantage tool
const AlphaVantageParamsSchema = z.object({
  symbol: z
    .string()
    .describe("The stock symbol to fetch data for (e.g., 'IBM')."),
  outputsize: z
    .enum(["compact", "full"])
    .default("compact")
    .optional()
    .describe(
      "'compact' returns the latest 100 data points, 'full' returns the full-length time series."
    ),
});

// Define the schema for the tool itself using the parameters schema
const alphaVantageToolSchemas = {
  getTimeSeriesDailyAdjusted: {
    description:
      "Fetches daily adjusted time series data for a given stock symbol.",
    parameters: AlphaVantageParamsSchema,
    // Assuming the result structure based on common Alpha Vantage formats
    result: z.array(
      z.object({
        date: z.string(),
        adjusted_close: z.union([z.string(), z.number()]),
      })
    ),
  },
};

// Helper function to adapt AlphaVantage results to our expected PriceHistory format
function adaptAlphaVantageResult(symbol: string, alphaVantageData: unknown[]) {
  if (!Array.isArray(alphaVantageData)) {
    console.warn(
      `Unexpected data format from AlphaVantage for ${symbol}:`,
      alphaVantageData
    );
    return { symbol, prices: [] };
  }
  return {
    symbol,
    prices: alphaVantageData
      .map((item: any) => ({
        date: item.date,
        price:
          typeof item.adjusted_close === "number"
            ? item.adjusted_close
            : parseFloat(item.adjusted_close || "0"),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function POST(req: Request) {
  const { messages } = await req.json();

  let mcpClient: MCPClientType | undefined;
  let resultStream: StreamTextResult<any> | undefined;

  try {
    // --- MCP Client Setup ---
    const mcpServerUrl =
      process.env.ALPHAVANTAGE_MCP_SSE_URL || "YOUR_ALPHAVANTAGE_MCP_SSE_URL";

    if (!mcpServerUrl || mcpServerUrl === "YOUR_ALPHAVANTAGE_MCP_SSE_URL") {
      console.warn(
        "AlphaVantage MCP SSE URL not configured. Stock fetching will be skipped."
      );
    } else {
      // MCP Client setup code remains here but won't actively fetch in this test
      mcpClient = await experimental_createMCPClient({
        transport: {
          type: "sse",
          url: mcpServerUrl,
        },
      });
    }
    console.log("mcpClient", mcpClient);

    // --- Tool Definition ---
    const mcpTools = mcpClient
      ? await mcpClient.tools({ schemas: alphaVantageToolSchemas })
      : {};

    // Adapt the MCP tool execute function to fit our PriceHistorySchema
    if (false && mcpTools.getTimeSeriesDailyAdjusted) {
      const originalExecute = mcpTools.getTimeSeriesDailyAdjusted.execute;
      mcpTools.getTimeSeriesDailyAdjusted.execute = async (
        args: z.infer<typeof AlphaVantageParamsSchema>
      ) => {
        console.log(`Calling AlphaVantage MCP tool for symbol: ${args.symbol}`);
        const result = await originalExecute(args);
        return adaptAlphaVantageResult(args.symbol, result as unknown[]);
      };
      mcpTools.getTimeSeriesDailyAdjusted.description =
        "Fetch historical daily adjusted closing prices for a stock symbol.";
    }

    const allTools = {
      generateEtfHoldings: generateEtfHoldingsTool,
      // Temporarily exclude other tools for this specific test
      // calculateEtfPerformance: calculateEtfPerformanceTool,
      // fetchStockHistory: mcpTools.getTimeSeriesDailyAdjusted,
    };

    console.log("messages", messages);
    // --- StreamText Call ---
    const resultStream = await streamText({
      model: openai("gpt-4o"),
      tools: allTools,
      maxSteps: 10,
      toolChoice: "auto",
      // Provide context for the forced tool call
      prompt: `User query: ${
        messages[messages.length - 1]?.content
      }\nBased ONLY on the user query, use the 'generateEtfHoldings' tool.`,
    });
    console.log("resultStream", resultStream);

    return resultStream.toDataStreamResponse();

    return resultStream.toDataStreamResponse({
      onFinish: async () => {
        if (mcpClient) {
          // Close client even if not used, for cleanup
          console.log("Closing MCP client (test mode)...");
          await mcpClient.close();
        }
      },
    });
  } catch (error) {
    console.error("Error in POST /api/chat (Step 1 Test):", error);
    if (mcpClient) {
      await mcpClient
        .close()
        .catch((closeErr) =>
          console.error(
            "Error closing MCP client on error (test mode):",
            closeErr
          )
        );
    }
    return new Response(
      JSON.stringify({ error: "An internal server error occurred." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
