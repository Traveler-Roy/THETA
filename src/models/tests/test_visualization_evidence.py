"""Synthetic trajectories must never be delivered as research evidence."""
import io
import sys
from pathlib import Path
from contextlib import redirect_stdout
import unittest
import tempfile
import numpy as np
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from visualization.visualization_generator import VisualizationGenerator


class VisualizationEvidenceTests(unittest.TestCase):
    def test_unobserved_trajectories_skip_without_random_values(self):
        log = io.StringIO()
        with tempfile.TemporaryDirectory() as home:
            generator = VisualizationGenerator(
                theta=np.array([[.8, .2], [.1, .9]]), beta=np.eye(2),
                vocab=['refund', 'delivery'],
                topic_words=[(0, [('refund', 1.)]), (1, [('delivery', 1.)])],
                output_dir=home, formats=['svg'])
            with patch('numpy.random.normal', side_effect=AssertionError('fabricated trajectory')), patch('numpy.random.uniform', side_effect=AssertionError('fabricated trajectory')), redirect_stdout(log):
                generator.generate_kl_divergence()
                generator.generate_topic_word_dist_change(0)
                generator.generate_topic_word_sense(0)
        self.assertEqual(log.getvalue().count('[SKIP]'), 3)
