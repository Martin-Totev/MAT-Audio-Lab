package backend

import (
	"fmt"
	"runtime"
)

type ButtonResponse struct {
	Message string `json:"message"`
	File    string `json:"file"`
	Line    int    `json:"line"`
}

func ExecuteButton1() ButtonResponse {
	_, _, line, _ := runtime.Caller(0)
	shortFile := "pkg/backend/button1.go"

	msg := fmt.Sprintf("clicked middleButton1 -> executing line %d in file %s", line, shortFile)
	return ButtonResponse{
		Message: msg,
		File:    shortFile,
		Line:    line,
	}
}