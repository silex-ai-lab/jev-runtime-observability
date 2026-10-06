#!/usr/bin/env python3
"""W1c §9.4 rule 6: the exact encoder limits for `kev.model.training_context(max_state)`.
Run with the Kev venv interpreter from the Kev checkout: python context_limits.py 1024"""
import json, sys
from kev.model import training_context

print(json.dumps(training_context(int(sys.argv[1]))))
