// Packages a Linux executable with Unix executable permissions, also on Windows.
package main

import (
	"archive/zip"
	"fmt"
	"os"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	data, err := os.ReadFile("build/bootstrap")
	if err != nil {
		return err
	}
	f, err := os.Create("build/backend.zip")
	if err != nil {
		return err
	}
	defer f.Close()
	z := zip.NewWriter(f)
	h := &zip.FileHeader{Name: "bootstrap", Method: zip.Deflate}
	h.SetMode(0755)
	w, err := z.CreateHeader(h)
	if err != nil {
		return err
	}
	if _, err = w.Write(data); err != nil {
		return err
	}
	if err = z.Close(); err != nil {
		return err
	}
	return f.Close()
}
