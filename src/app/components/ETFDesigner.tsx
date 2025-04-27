"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// --- Type Definitions (align with backend tools) ---
type Holding = {
  symbol: string;
  name: string;
  weight: number;
  country?: string; // Optional country
};

type ETFPerformancePoint = {
  date: string;
  value: number;
};

export type ETFResultData = {
  etfName: string;
  holdings: Holding[];
  etfPerformance: ETFPerformancePoint[];
  error?: string; // Optional error message
};

// --- Component Props ---
interface ETFDesignerProps {
  data: ETFResultData;
}

// --- Helper Functions ---
const formatXAxisTick = (dateString: string) => {
  try {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  } catch (e) {
    return dateString; // Fallback
  }
};

const formatTooltipValue = (value: number) => {
  return [`${value.toFixed(2)}`, "Indexed Value"]; // Adjusted label
};

const formatTooltipLabel = (dateString: string) => {
  try {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch (e) {
    return dateString; // Fallback
  }
};

// --- ETFDesigner Component ---
export default function ETFDesigner({ data }: ETFDesignerProps) {
  const { etfName, holdings, etfPerformance, error } = data;

  if (error) {
    return (
      <div className="w-full max-w-4xl mx-auto p-4 border border-red-400 bg-red-50 rounded-md">
        <h2 className="text-xl font-semibold text-red-700 mb-2">
          Error Designing ETF
        </h2>
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  if (!holdings || holdings.length === 0) {
    return (
      <div className="w-full max-w-4xl mx-auto p-4 border border-yellow-400 bg-yellow-50 rounded-md">
        <h2 className="text-xl font-semibold text-yellow-700 mb-2">
          No Holdings Found
        </h2>
        <p className="text-yellow-600">
          Could not generate or parse holdings for the given query.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto p-4 space-y-8">
      {/* ETF Name Header */}
      <h1 className="text-3xl font-bold text-center mb-6">
        {etfName || "Custom ETF"}
      </h1>

      {/* Holdings Table */}
      <div>
        <h2 className="text-2xl font-semibold mb-4">Holdings</h2>
        <div className="overflow-x-auto shadow-md rounded-lg">
          <table className="min-w-full bg-white border border-gray-200">
            <thead className="bg-gray-100">
              <tr>
                <th className="py-3 px-4 border-b border-gray-200 text-left text-sm font-semibold text-gray-600 uppercase tracking-wider">
                  Symbol
                </th>
                <th className="py-3 px-4 border-b border-gray-200 text-left text-sm font-semibold text-gray-600 uppercase tracking-wider">
                  Name
                </th>
                {/* Conditionally show Country if available in any holding */}
                {holdings.some((h) => h.country) && (
                  <th className="py-3 px-4 border-b border-gray-200 text-left text-sm font-semibold text-gray-600 uppercase tracking-wider">
                    Country
                  </th>
                )}
                <th className="py-3 px-4 border-b border-gray-200 text-right text-sm font-semibold text-gray-600 uppercase tracking-wider">
                  Weight (%)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {holdings.map((holding) => (
                <tr
                  key={holding.symbol}
                  className="hover:bg-gray-50 transition-colors duration-150"
                >
                  <td className="py-3 px-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    {holding.symbol}
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap text-sm text-gray-600">
                    {holding.name}
                  </td>
                  {holdings.some((h) => h.country) && (
                    <td className="py-3 px-4 whitespace-nowrap text-sm text-gray-600">
                      {holding.country || "-"}
                    </td>
                  )}
                  <td className="py-3 px-4 whitespace-nowrap text-sm text-gray-600 text-right">
                    {holding.weight.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Performance Chart (only if data exists) */}
      {etfPerformance && etfPerformance.length > 0 ? (
        <div>
          <h2 className="text-2xl font-semibold mb-4">
            Performance (Indexed to 100)
          </h2>
          <div className="w-full h-[400px] bg-white p-4 rounded-lg shadow-md">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={etfPerformance} // Use all data points for now
                margin={{ top: 5, right: 30, left: 0, bottom: 5 }} // Adjusted left margin
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 12, fill: "#666" }}
                  tickFormatter={formatXAxisTick}
                  angle={-30} // Angle ticks slightly if crowded
                  textAnchor="end"
                  height={50} // Increase height for angled ticks
                  interval="preserveStartEnd" // Ensure start/end dates show
                />
                <YAxis
                  tick={{ fontSize: 12, fill: "#666" }}
                  domain={["auto", "auto"]} // Auto-scale Y axis
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: "8px",
                    boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
                  }}
                  formatter={formatTooltipValue}
                  labelFormatter={formatTooltipLabel}
                />
                <Legend wrapperStyle={{ paddingTop: "20px" }} />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#1d4ed8" // Blue color
                  strokeWidth={2}
                  dot={false} // Hide dots for cleaner line
                  activeDot={{ r: 5, fill: "#1d4ed8" }}
                  name={etfName || "ETF Value"}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="p-4 border border-gray-200 bg-gray-50 rounded-md text-center">
          <p className="text-gray-600">
            Performance data could not be calculated or is unavailable.
          </p>
        </div>
      )}
    </div>
  );
}
