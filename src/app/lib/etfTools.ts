import { openai } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

// Define schemas for reuse
const HoldingSchema = z.object({
  symbol: z.string(),
  name: z.string(), // Keep name, we'll use symbol if name isn't parsed
  weight: z.number(),
  country: z.string().optional(), // Country might be hard to parse reliably
});

const PricePointSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  price: z.number(),
});

const PriceHistorySchema = z.object({
  symbol: z.string(),
  prices: z.array(PricePointSchema),
});

// Helper function to generate an ETF name (can be improved)
function generateEtfName(query: string): string {
  // Removed primaryCountry as it's not reliably determined here
  let prefix = ""; // Start blank, let LLM decide or use default
  let focus = "";

  // Basic keyword checks, LLM might provide better context
  if (query.toLowerCase().includes("pharma")) focus = "PHARMA";
  else if (query.toLowerCase().includes("tech")) focus = "TECH";
  else if (query.toLowerCase().includes("energy")) focus = "ENERGY";
  else if (query.toLowerCase().includes("finance")) focus = "FINANCE";
  else focus = "GENERAL";

  if (query.toLowerCase().includes("non-us")) prefix = "NON-US";
  else if (query.toLowerCase().includes("europe")) prefix = "EU";
  else if (query.toLowerCase().includes("asia")) prefix = "ASIA";
  else if (query.toLowerCase().includes("emerging")) prefix = "EM";
  else prefix = "GLOBAL"; // Default prefix

  return `${prefix}-${focus} ETF`;
}

// --- Tool Definitions ---

export const generateEtfHoldingsTool = tool({
  description:
    "Generate a list of holdings (stock symbols and weights) for a proposed ETF based on a user query.",
  parameters: z.object({
    query: z
      .string()
      .describe(
        'The user query describing the ETF characteristics (e.g., "non-US pharma companies", "European tech stocks").'
      ),
  }),
  execute: async ({ query }) => {
    console.log(`Generating holdings for query: ${query}`);

    // Ask the LLM to generate holdings in a parsable format
    const { text } = await generateText({
      model: openai("o1-mini"),
      prompt: `Generate a list of potential holdings for an ETF based on the user query: "${query}". 
      Provide the response as a list, with each item formatted as: "SYMBOL: WEIGHT%" (e.g., "AAPL: 15%"). 
      Include only the list items, no introductory or concluding text.`,
      // Add parameters like temperature if needed for consistency
    });

    console.log("Raw LLM holdings output:", text);

    const holdings: z.infer<typeof HoldingSchema>[] = [];
    const lines = text.trim().split("\n");
    // Regex to capture SYMBOL and WEIGHT%
    // Allows symbols like AAPL, MSFT, NOVN.SW, ERIC-B.ST etc. Allows optional space before %
    const holdingRegex = /([A-Z0-9\.\-]+):\s*(\d+(?:\.\d+)?)\s*%?/;

    for (const line of lines) {
      const match = line.trim().match(holdingRegex);
      if (match && match[1] && match[2]) {
        const symbol = match[1].toUpperCase();
        const weight = parseFloat(match[2]);
        if (!isNaN(weight)) {
          holdings.push({
            symbol: symbol,
            name: symbol, // Use symbol as name initially, can enhance later
            weight: weight,
            // country: undefined // Country info is not requested/parsed here
          });
        }
      }
    }

    console.log("Parsed holdings:", holdings);

    if (holdings.length === 0) {
      console.warn("Could not parse any holdings from the LLM response.");
      // Optionally return an error or a specific structure indicating failure
      return { holdings: [], etfName: generateEtfName(query) + "-EMPTY" };
    }

    // Normalize weights to sum to 100
    const totalWeight = holdings.reduce((sum, h) => sum + h.weight, 0);
    // Handle cases where total weight is 0 to avoid division by zero
    const normalizedHoldings =
      totalWeight > 0
        ? holdings.map((h) => ({
            ...h,
            weight: parseFloat(((h.weight / totalWeight) * 100).toFixed(2)),
          }))
        : holdings; // Return as is if totalWeight is 0

    console.log("Normalized holdings:", normalizedHoldings);

    return {
      holdings: normalizedHoldings,
      etfName: generateEtfName(query), // Generate name based on original query
    };
  },
});

export const calculateEtfPerformanceTool = tool({
  description:
    "Calculate the weighted performance of an ETF based on its holdings and their historical price data.",
  parameters: z.object({
    etfName: z.string().describe("The name of the ETF."),
    holdings: z
      .array(HoldingSchema)
      .describe("The list of holdings with their weights."),
    priceHistories: z
      .array(PriceHistorySchema)
      .describe("An array containing the price history for each holding."),
  }),
  execute: async ({ etfName, holdings, priceHistories }) => {
    console.log(`Calculating performance for ETF: ${etfName}`);
    if (priceHistories.length === 0 || holdings.length === 0) {
      console.warn(
        "Cannot calculate performance with empty price histories or holdings."
      );
      return { etfPerformance: [] };
    }
    try {
      // Map price histories by symbol for quick lookup
      const priceMap = new Map(priceHistories.map((h) => [h.symbol, h.prices]));

      // Find the common date range
      const allDates = new Set<string>(); // Changed let to const based on linter
      priceHistories.forEach((history) => {
        history.prices.forEach((price) => allDates.add(price.date));
      });
      let sortedDates = Array.from(allDates).sort();

      // Ensure all holdings have data for the start date, find earliest common start date
      let commonStartDate = sortedDates[0];
      if (!commonStartDate) {
        console.warn("No dates found in price histories.");
        return { etfPerformance: [] };
      }
      for (const holding of holdings) {
        const history = priceMap.get(holding.symbol);
        if (history && history.length > 0) {
          const holdingStartDate = history[0].date;
          if (holdingStartDate > commonStartDate) {
            commonStartDate = holdingStartDate;
          }
        }
      }
      sortedDates = sortedDates.filter((date) => date >= commonStartDate);

      if (sortedDates.length === 0) {
        console.warn("No common dates found for calculation after filtering.");
        return { etfPerformance: [] };
      }

      // Normalize prices to start at 100 on the first common date
      const initialValues = new Map<string, number>();
      holdings.forEach((holding) => {
        const history = priceMap.get(holding.symbol);
        const initialPricePoint = history?.find(
          (p) => p.date === sortedDates[0]
        );
        if (initialPricePoint && initialPricePoint.price > 0) {
          initialValues.set(holding.symbol, initialPricePoint.price);
        } else {
          console.warn(
            `Missing or invalid initial price for ${holding.symbol} on ${sortedDates[0]}`
          );
          // Optionally exclude this holding if it lacks initial data
        }
      });

      // Calculate weighted indexed performance
      const etfPerformance = sortedDates.map((date) => {
        let weightedValue = 0;
        let totalWeightForDate = 0;

        holdings.forEach((holding) => {
          const initialPrice = initialValues.get(holding.symbol);
          const history = priceMap.get(holding.symbol);
          const pricePoint = history?.find((p) => p.date === date);

          if (pricePoint && initialPrice && initialPrice > 0) {
            const indexedPrice = (pricePoint.price / initialPrice) * 100;
            weightedValue += indexedPrice * (holding.weight / 100);
            totalWeightForDate += holding.weight / 100;
          }
        });

        // Adjust if some holdings didn't have data for this specific date
        const finalValue =
          totalWeightForDate > 0 ? weightedValue / totalWeightForDate : 100; // Default to 100 if no data

        return {
          date,
          value: parseFloat(finalValue.toFixed(2)),
        };
      });

      return {
        etfPerformance,
      };
    } catch (error) {
      console.error("Error calculating ETF performance:", error);
      // Return an error structure or throw, depending on desired handling
      return { error: "Failed to calculate ETF performance" };
    }
  },
});

// "2025-03-11": {\n' +
//  "1. open": "94.9800",\n' +
//  "2. high": "95.3800",\n' +
//  "3. low": "93.5800",\n' +
//  "4. close": "94.7300",\n' +
//  "5. volume": "21734793"\n' + }
export const AlphaVantageDailyPriceSchema = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

// Parse Alpha Vantage API response into AlphaVantageDailyPriceSchema objects
export function parseAlphaVantageResponse(
  data: any
): Record<string, z.infer<typeof AlphaVantageDailyPriceSchema>[]> {
  console.log("data", data);
  if (!data || typeof data !== "object") {
    console.warn("Invalid Alpha Vantage response data");
    return {};
  }

  try {
    // Extract ticker symbol from meta data
    const metaData = data["Meta Data"];
    const ticker =
      metaData && metaData["2. Symbol"] ? metaData["2. Symbol"] : "UNKNOWN";

    // Get time series data
    const timeSeriesData = data["Time Series (Daily)"];
    if (!timeSeriesData || typeof timeSeriesData !== "object") {
      console.warn(`No time series data found for ${ticker}`);
      return { [ticker]: [] };
    }

    // Parse each date entry
    const prices: z.infer<typeof AlphaVantageDailyPriceSchema>[] = [];

    for (const date in timeSeriesData) {
      if (Object.prototype.hasOwnProperty.call(timeSeriesData, date)) {
        const dayData = timeSeriesData[date];

        // Parse numeric values, handling possible string format
        prices.push({
          date,
          open: parseFloat(dayData["1. open"]),
          high: parseFloat(dayData["2. high"]),
          low: parseFloat(dayData["3. low"]),
          close: parseFloat(dayData["4. close"]),
          volume: parseFloat(dayData["5. volume"]),
        });
      }
    }

    // Sort by date ascending
    prices.sort((a, b) => a.date.localeCompare(b.date));

    return { [ticker]: prices };
  } catch (error) {
    console.error("Error parsing Alpha Vantage response:", error);
    return {};
  }
}
