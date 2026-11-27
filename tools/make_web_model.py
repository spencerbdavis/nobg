"""Build the browser model: ISNet-general, main output only, fp16 weights with float32 I/O.
Run by fetch-models.sh inside a throwaway container. Output is checked against a known SHA-256."""
import sys
import warnings

warnings.filterwarnings("ignore")
import onnx  # noqa: E402
from onnxconverter_common import float16  # noqa: E402

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
onnx.utils.extract_model(src, "/tmp/main.onnx", [m.graph.input[0].name], [m.graph.output[0].name])
m16 = float16.convert_float_to_float16(onnx.load("/tmp/main.onnx"), keep_io_types=True)
onnx.save(m16, dst)
print("wrote", dst)
