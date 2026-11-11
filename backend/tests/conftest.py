"""Test-wide settings.

research/__init__.py loads .env, which points MLFLOW_TRACKING_URI at the real
tracking server. Tests must never write runs there: an empty value (set before
any research module is imported) wins over .env and switches MLflow off.
Tests that exercise the MLflow code set their own file-based URI.
"""
import os

os.environ["MLFLOW_TRACKING_URI"] = ""
