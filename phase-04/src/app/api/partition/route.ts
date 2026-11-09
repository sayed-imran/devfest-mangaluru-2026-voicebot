import {
  deliveryIntentHeuristic,
  pickHandoffLine,
  type DeliveryIntent,
} from "@/lib/partition";
import { checkLayaHealth, decideDeliveryFromUser } from "@/lib/laya";
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

/**
 * Decide speak-all vs handoff from the user utterance *before* the LLM runs.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      userText?: string;
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
      display: "",
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
