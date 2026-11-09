import {
  deliveryIntentHeuristic,
  pickHandoffLine,
  type DeliveryIntent,
} from "@/lib/partition";
import { checkLayaHealth, decideDeliveryFromUser } from "@/lib/laya";
import { routeTurn, type ToolsRoute } from "@/lib/tools";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const laya = await checkLayaHealth();
  return NextResponse.json({
    ok: true,
    laya: laya.ok,
    error: laya.error,
    phase: "user-intent",
  });
}

function routingInfo(tools: ToolsRoute | null) {
  if (!tools) return { ok: false };
  return {
    ok: true,
    route: tools.route,
    decidedBy: tools.decided_by,
    confidence: tools.confidence,
    rule: tools.rule,
    pAction: tools.laya.p_action ?? null,
  };
}

/**
 * Decide, before the LLM runs, whether this turn is a computer action
 * (tools service → Laya) and, for chat turns, speak-all vs handoff.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      userText?: string;
      lastAssistant?: string;
      /** @deprecated assistant text is no longer used for the primary decision */
      text?: string;
    };

    const userText =
      typeof body.userText === "string"
        ? body.userText.trim()
        : typeof body.text === "string"
          ? body.text.trim()
          : "";

    if (!userText) {
      return NextResponse.json(
        { error: "Missing `userText`" },
        { status: 400 },
      );
    }

    const tools = await routeTurn({
      userText,
      lastAssistant:
        typeof body.lastAssistant === "string" ? body.lastAssistant : "",
      signal: request.signal,
    });

    // Actions get a short spoken confirmation, so no delivery decision is needed.
    if (tools?.route === "action") {
      return NextResponse.json({
        mode: "speak-all",
        speak: "",
        decidedBy: tools.decided_by === "laya" ? "laya" : "heuristic",
        route: "action",
        display: "",
        routing: routingInfo(tools),
        laya: { ok: false },
      });
    }

    const decision = await decideDeliveryFromUser({
      userText,
      signal: request.signal,
    });

    let intent: DeliveryIntent;
    if (decision) {
      intent = decision.speakFully
        ? { mode: "speak-all", speak: "", decidedBy: "laya" }
        : {
            mode: "handoff",
            speak: pickHandoffLine(),
            decidedBy: "laya",
          };
    } else {
      intent = deliveryIntentHeuristic(userText);
    }

    return NextResponse.json({
      ...intent,
      route: "chat",
      display: "",
      routing: routingInfo(tools),
      laya: decision
        ? {
            ok: true,
            speakFully: decision.speakFully,
            confidence: decision.confidence,
            choice: decision.choice,
          }
        : { ok: false },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
