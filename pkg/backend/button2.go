package backend

import (
	"fmt"
	"runtime"
)

func ExecuteButton2() ButtonResponse {
	_, _, line, _ := runtime.Caller(0)
	shortFile := "pkg/backend/button2.go"

	msg := fmt.Sprintf("Metronome Test workspace toggled at line %d in file %s", line, shortFile)
	return ButtonResponse{
		Message: msg,
		File:    shortFile,
		Line:    line,
	}
}
