import asyncio

import pytest

from gemma_tools import routing

COMMANDS = [
    "open youtube",
    "Hey Gemma, open YouTube.",
    "search youtube for lofi hip hop",
    "play despacito on youtube",
    "google the weather in bangalore",
    "draft an email to my manager saying I'll be late tomorrow",
    "write a mail to john about the meeting",
    "compose an email to hr asking for leave on friday",
    "I want to watch some funny cat videos",
    "can you pull up the latest news?",
    "show me directions to the airport",
    "Get me direction to Mangalore Airport for my current location.",
    "get me directions to mangalore airport",
    "give me the route to panambur beach",
    "find the way to the railway station",
    "show me the way to St. Aloysius Chapel",
    "directions to the bus stand",
    "direction from Hampankatta to Kadri temple",
    "navigate me to the nearest petrol pump",
    "route me to Surathkal",
    "show me cat videos on youtube",
    "open calculator",
    "look up python tutorials",
    "take me to github",
    "put on some relaxing music",
    "email john about tomorrow",
    "could you please search for the best restaurants near me",
]
CHATS = [
    "hello gemma",
    "thank you",
    "what is the capital of france",
    "tell me about black holes",
    "who won the world cup in 2022",
    "how are you doing today",
    "what did I ask you before?",
    "what is the best way to learn rust",
]
UNDECIDED = [
    "write me an essay about climate change",
    "can you help me write a poem about rain",
    "find me a video on how to tie a tie",
    "how do I open a new tab in chrome?",
    "give me some directions on how to write a cover letter",
    "explain how youtube's recommendation algorithm works",
]


@pytest.mark.parametrize("text", COMMANDS)
def test_commands_route_to_action(text):
    assert routing.rule_route(text)[0] == "action"


@pytest.mark.parametrize("text", CHATS)
def test_chat_routes_to_chat(text):
    assert routing.rule_route(text)[0] == "chat"


@pytest.mark.parametrize("text", UNDECIDED)
def test_ambiguous_turns_are_left_to_laya(text):
    assert routing.rule_route(text) == (None, None)


def test_follow_up_needs_an_offer():
    offer = "I found a lofi playlist. Want me to play it?"
    assert routing.rule_route("yes go ahead", offer) == ("action", "follow-up")
    assert routing.rule_route("sure, play the first one", offer)[0] == "action"
    assert routing.rule_route("yes", "The capital of France is Paris.")[0] is None
    assert routing.rule_route("thanks", "Should I open it?")[0] == "chat"


def test_route_question_carries_extra_hints():
    q = routing.route_questions(["browse a web page"])["intent"]
    assert q["type"] == "choice"
    assert set(q["criteria"]) == {"act", "talk"}
    assert q["criteria"]["act"].endswith("; browse a web page")


class FakeLaya:
    def __init__(self, p):
        self.p = p

    async def p_action(self, text, last_assistant, hints):
        if self.p is None:
            return {"ok": False, "error": "offline", "latency_ms": 1}
        return {"ok": True, "p_action": self.p, "latency_ms": 1}


def decide(text, p, **kwargs):
    return asyncio.run(routing.decide_route(FakeLaya(p), text, **kwargs))


def test_laya_decides_when_rules_have_no_opinion():
    d = decide("find me a video on how to tie a tie", 0.52)
    assert (d.route, d.decided_by) == ("action", "laya")
    d = decide("write me an essay about climate change", 0.35)
    assert (d.route, d.decided_by) == ("chat", "laya")


def test_rules_override_laya_misses_and_agreement_is_credited_to_laya():
    d = decide("write a mail to john about the meeting", 0.35)
    assert (d.route, d.decided_by, d.rule) == ("action", "rules", "command")
    d = decide("open youtube", 0.93)
    assert (d.route, d.decided_by) == ("action", "laya")
    d = decide("hello gemma", 0.56)
    assert (d.route, d.decided_by) == ("chat", "rules")


def test_laya_offline_falls_back_to_rules():
    assert decide("open youtube", None).route == "action"
    d = decide("find me a video on how to tie a tie", None)
    assert (d.route, d.decided_by) == ("chat", "rules")


def test_threshold_is_respected():
    assert decide("find me a video on how to tie a tie", 0.55, threshold=0.6).route == "chat"
