import json
from pathlib import Path
import pytest
from seudaily.local_operations import validate_proposal, default_summary

CASES = json.loads(Path(__file__).with_name('fixtures').joinpath('local-operation-cases.json').read_text())

@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_shared_contract_cases(case):
    if not case['accepted']:
        with pytest.raises(ValueError):
            validate_proposal(case['input'])
    else:
        normalized = validate_proposal(case['input'])
        assert normalized['mode'] == 'preview'
        if case['name'] == 'sorted weeks and defaults':
            assert normalized['schedule']['course']['weeks'] == [1, 2, 3]
            assert normalized['schedule']['course']['teacherName'] == ''

def test_default_summary_uses_contract():
    assert default_summary('apply-agent-schedule-change', 'move') == '单次课程已移动。'
