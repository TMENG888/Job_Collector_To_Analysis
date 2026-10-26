import unittest
from run_wordcloud_uie_trial import decode_spans
from run_wordcloud_gliner_trial import MixedCharSplitter


class TrialIntegrityTests(unittest.TestCase):
    def test_prompt_spans_are_not_document_evidence(self):
        result = decode_spans([0, .99, 0, .9, 0], [0, .99, 0, .8, 0],
                              [[0, 0], [0, 2], [0, 0], [0, 6], [0, 0]],
                              [None, 0, None, 1, None], "Python", 0, .5)
        self.assertEqual([r["text"] for r in result], ["Python"])

    def test_chunk_offset_is_preserved(self):
        result = decode_spans([.9], [.9], [[0, 4]], [1], "abcJava", 3, .5)
        self.assertEqual((result[0]["start"], result[0]["end"], result[0]["text"]), (3, 7, "Java"))

    def test_end_matches_nearest_preceding_start(self):
        result = decode_spans([.9, .9, 0], [0, 0, .9], [[0, 1], [1, 2], [2, 3]],
                              [1, 1, 1], "甲乙丙", 0, .5)
        self.assertEqual([r["text"] for r in result], ["乙丙"])

    def test_mixed_splitter_preserves_technical_tokens_and_offsets(self):
        text = "熟悉C++、JavaScript和SQL/MySQL"
        tokens = list(MixedCharSplitter()(text))
        self.assertIn("C++", [t[0] for t in tokens])
        self.assertIn("JavaScript", [t[0] for t in tokens])
        self.assertTrue(all(text[start:end] == token for token, start, end in tokens))

    def test_no_extraction_without_both_endpoints(self):
        self.assertEqual(decode_spans([.9], [.1], [[0, 1]], [1], "甲", 0, .5), [])

    def test_splitter_does_not_attach_sentence_period(self):
        self.assertEqual([t[0] for t in MixedCharSplitter()("Google.")], ["Google", "."])

    def test_splitter_preserves_c_family_and_dot_framework(self):
        self.assertEqual([t[0] for t in MixedCharSplitter()("C/C++ C# Node.js")], ["C/C++", "C#", "Node.js"])


if __name__ == "__main__":
    unittest.main()
