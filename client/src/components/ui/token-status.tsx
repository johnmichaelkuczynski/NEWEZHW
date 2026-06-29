import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Coins, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

interface TokenStatusProps {
  sessionId?: string;
}

export function TokenStatus({ sessionId }: TokenStatusProps) {
  const { data: user, isLoading: userLoading } = useQuery<any>({
    queryKey: ["/api/me"],
    queryFn: async () => {
      const response = await fetch("/api/me", {
        credentials: "include",
      });
      
      if (!response.ok) {
        return null;
      }
      
      return response.json();
    },
    retry: true,
    refetchOnMount: true,
  });

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}K`;
    }
    return tokens.toLocaleString();
  };

  if (userLoading) {
    return (
      <Card className="w-full">
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading...</span>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const tokenBalance = user?.tokenBalance || 99999999;

  return (
    <Card className="w-full">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-green-500" />
            <span className="text-sm font-medium">JMK</span>
            <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">
              Unlimited Access
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-yellow-500" />
            <span className="text-sm font-medium">{formatTokens(tokenBalance)} tokens</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
