"""Language-processing components that sit between raw news and the engine.

entity_linker    — headline → NSE symbol linking (replaces substring matching)
substring_linker — the original substring matcher, kept as the E3 baseline
service          — cached, DB-backed linker for the routers and the engine
"""
