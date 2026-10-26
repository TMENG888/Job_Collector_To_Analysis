import unittest
from evaluate_cluster_reference import learn_mapping,score,pair_metrics,ABSTAIN

def row(key,label,split='test',confidence='high'):
    return {'id':key,'key':key,'label':label,'split':split,'confidence':confidence,'company_hash':key}

class ReferenceMetricsTests(unittest.TestCase):
    def test_mapping_ignores_test_truth(self):
        rows=[row('a','it_ops','calibration'),row('b','sales'),row('c','sales')]
        mapping,_=learn_mapping(rows,{'a':0,'b':0,'c':0})
        self.assertEqual(mapping,{0:'it_ops'})

    def test_mapping_excludes_ambiguous_and_noise(self):
        mapping,_=learn_mapping([row('a','mixed','calibration'),row('b','sales','calibration')],{'a':1,'b':-1})
        self.assertEqual(mapping,{})

    def test_tie_is_deterministic(self):
        mapping,_=learn_mapping([row('a','sales','calibration'),row('b','it_ops','calibration')],{'a':0,'b':0})
        self.assertEqual(mapping,{0:'it_ops'})

    def test_noise_and_unsupported_are_errors(self):
        rows=[row('a','it_ops'),row('b','it_ops'),row('c','it_ops'),row('d','insufficient')]
        m=score(rows,{'a':0,'b':-1,'c':2,'d':0},{0:'it_ops'})
        self.assertEqual((m['rows'],m['correct'],m['noise_rows'],m['unsupported_cluster_rows']),(3,1,1,1))
        self.assertAlmostEqual(m['accuracy'],1/3)
        self.assertAlmostEqual(m['per_class']['it_ops']['recall'],1/3)
        self.assertAlmostEqual(m['per_class']['it_ops']['precision'],1)
        self.assertEqual(m['covered_accuracy'],1)
        self.assertEqual(m['predictions'][1]['prediction'],ABSTAIN)

    def test_noise_not_one_cluster(self):
        p=pair_metrics(['it_ops','it_ops','sales'],[-1,-1,-1])
        self.assertEqual(p['same_cluster_pairs'],0)
        self.assertEqual(p['recall'],0)

    def test_perfect_mapping(self):
        m=score([row('a','it_ops'),row('b','sales')],{'a':0,'b':1},{0:'it_ops',1:'sales'})
        self.assertEqual(m['accuracy'],1)
        self.assertEqual(m['macro_f1_test_supported_classes'],1)

if __name__=='__main__':unittest.main()
