#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_dir=${TMPDIR:-/tmp}/babot-external-protocol-test
mkdir -p "$build_dir"

c++ -std=c++11 -Wall -Wextra -Werror \
  "$test_dir/external_protocol_test.cpp" \
  "$test_dir/../ExternalProtocol.cpp" \
  -o "$build_dir/external_protocol_test"
"$build_dir/external_protocol_test"

c++ -std=c++11 -Wall -Wextra -Werror \
  "$test_dir/ik_envelope_test.cpp" \
  "$test_dir/../ExternalProtocol.cpp" \
  -o "$build_dir/ik_envelope_test"
"$build_dir/ik_envelope_test"

c++ -std=c++11 -Wall -Wextra -Werror \
  "$test_dir/servo_output_test.cpp" \
  "$test_dir/../ServoOutput.cpp" \
  -o "$build_dir/servo_output_test"
"$build_dir/servo_output_test"
echo "external protocol tests passed"
