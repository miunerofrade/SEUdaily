"""Cached terminal layout with scrolling measured in visible screen rows."""
from __future__ import annotations

from collections.abc import Callable

from prompt_toolkit.data_structures import Point
from prompt_toolkit.layout.controls import UIContent, UIControl
from prompt_toolkit.mouse_events import MouseEvent, MouseEventType
from prompt_toolkit.utils import get_cwidth


class TranscriptView(UIControl):
    def __init__(
        self,
        fragments: Callable[[], list[tuple[str, str]]],
        get_scroll: Callable[[], int | None],
        set_scroll: Callable[[int | None], None],
        on_scroll: Callable[[], None],
    ):
        self.fragments = fragments
        self.get_scroll, self.set_scroll = get_scroll, set_scroll
        self.on_scroll = on_scroll
        self._source: list[tuple[str, str]] | None = None
        self._width = -1
        self.lines: list[list[tuple[str, str]]] = [[("", "  ")]]
        self.height = 1

    @property
    def max_scroll(self) -> int:
        return max(0, len(self.lines) - self.height)

    @property
    def top(self) -> int:
        offset = self.get_scroll()
        return self.max_scroll if offset is None else min(self.max_scroll, max(0, offset))

    def scroll(self, amount: int) -> None:
        offset = min(self.max_scroll, max(0, self.top + amount))
        self.set_scroll(None if offset == self.max_scroll else offset)
        self.on_scroll()

    def mouse_handler(self, mouse_event: MouseEvent):
        # Handle the entire viewport, including blank cells and trailing spaces.
        if mouse_event.event_type == MouseEventType.SCROLL_UP:
            self.scroll(-3)
        elif mouse_event.event_type == MouseEventType.SCROLL_DOWN:
            self.scroll(3)
        else:
            return NotImplemented

    def create_content(self, width: int, height: int) -> UIContent:
        self.height = max(1, height)
        source = self.fragments()
        if source is not self._source or width != self._width:
            self._source, self._width = source, width
            available = max(1, width - 2)
            lines: list[list[tuple[str, str]]] = [[("", "  ")]]
            used = 0
            for style, text in source:
                for char in text.expandtabs(4):
                    if char == "\n":
                        lines.append([("", "  ")])
                        used = 0
                        continue
                    size = get_cwidth(char)
                    if used and used + size > available:
                        lines.append([("", "  ")])
                        used = 0
                    line = lines[-1]
                    if line[-1][0] == style:
                        line[-1] = (style, line[-1][1] + char)
                    else:
                        line.append((style, char))
                    used += size
            self.lines = lines
        if self.get_scroll() is not None:
            self.set_scroll(self.top)
        cursor = self.top if self.get_scroll() is not None else len(self.lines) - 1
        return UIContent(
            get_line=lambda index: self.lines[index], line_count=len(self.lines),
            cursor_position=Point(x=0, y=cursor), show_cursor=False,
        )
