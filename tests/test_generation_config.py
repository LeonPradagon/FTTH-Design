import pytest
from backend.services.generator.generation_config import GenerationConfig
from pydantic import ValidationError

def test_default_config():
    config = GenerationConfig()
    assert config.odp_capacity == 10
    assert config.odc_capacity == 4
    assert config.max_odp_radius_m == 150.0
    assert config.max_odc_radius_m == 500.0
    assert config.routing_strategy == "shortest"

def test_custom_config():
    config = GenerationConfig(
        odp_capacity=16,
        odc_capacity=16,
        max_odp_radius_m=100.0,
        routing_strategy="priority_road"
    )
    assert config.odp_capacity == 16
    assert config.odc_capacity == 16
    assert config.max_odp_radius_m == 100.0
    assert config.routing_strategy == "priority_road"

def test_invalid_config():
    with pytest.raises(ValidationError):
        GenerationConfig(odp_capacity=0) # Must be > 0

    with pytest.raises(ValidationError):
        GenerationConfig(max_odp_radius_m=-5.0)

    with pytest.raises(ValidationError):
        GenerationConfig(odc_capacity=0)
