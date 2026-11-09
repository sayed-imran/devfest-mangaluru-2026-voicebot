from gemma_tools.llm import clean_text, parse_gemma_args, parse_text_tool_calls


def test_real_gemma_output_from_hermes_parser():
    content = '<|tool_call>call:search_youtube{query:<|"|>lofi hip hop beats<|"|>}<tool_call|>'
    calls = parse_text_tool_calls(content)
    assert [(c.name, c.arguments) for c in calls] == [("search_youtube", {"query": "lofi hip hop beats"})]
    assert clean_text(content) == ""


def test_gemma_args_types_and_nesting():
    args = parse_gemma_args(
        'to:<|"|>a@b.co<|"|>,count:3,ratio:0.5,urgent:true,cc:null,'
        'meta:{tone:<|"|>formal<|"|>,tags:[<|"|>x<|"|>,<|"|>y<|"|>]},'
        'body:<|"|>Hi, {team}: see [notes], thanks!<|"|>'
    )
    assert args == {
        "to": "a@b.co",
        "count": 3,
        "ratio": 0.5,
        "urgent": True,
        "cc": None,
        "meta": {"tone": "formal", "tags": ["x", "y"]},
        "body": "Hi, {team}: see [notes], thanks!",
    }


def test_multiple_calls_and_turn_terminator():
    content = (
        '<|tool_call>call:open_youtube{}<tool_call|>'
        '<|tool_call>call:web_search{query:<|"|>weather delhi<|"|>,engine:<|"|>bing<|"|>}<turn|>'
    )
    calls = parse_text_tool_calls(content)
    assert [c.name for c in calls] == ["open_youtube", "web_search"]
    assert calls[1].arguments == {"query": "weather delhi", "engine": "bing"}
    assert len({c.id for c in calls}) == 2


def test_hermes_style_calls():
    content = 'Sure.<tool_call>{"name": "open_app", "arguments": {"app": "calculator"}}</tool_call>'
    calls = parse_text_tool_calls(content)
    assert [(c.name, c.arguments) for c in calls] == [("open_app", {"app": "calculator"})]
    assert clean_text(content) == "Sure."


def test_clean_text_drops_empty_thought_channel():
    assert clean_text("<|channel>thought\n<channel|>I've opened YouTube.") == "I've opened YouTube."
    assert clean_text("Plain answer.") == "Plain answer."
