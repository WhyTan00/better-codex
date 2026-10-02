#!/usr/bin/env python3
"""Compatibility entry: exports the maintained portable dependency closure."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name("prepare-portable-source.py")),run_name="__main__")
