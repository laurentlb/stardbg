package main

import (
	"bufio"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/golang/protobuf/proto"
	pb "github.com/laurentlb/stardbg/starlark_debugging"
	"google.golang.org/protobuf/encoding/protojson"
)

type arrayFlags []string

func (i *arrayFlags) String() string {
	return "my string representation"
}

func (i *arrayFlags) Set(value string) error {
	*i = append(*i, value)
	return nil
}

var breakpoints arrayFlags

type handler struct {
	conn net.Conn
}

// TODO(laurentlb): Remove global.
var globalConn net.Conn

type breakpointMessage struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

func recv(conn net.Conn, br *bufio.Reader, updateChannel chan []byte) {
	size, err := binary.ReadUvarint(br)
	if err == io.EOF {
		fmt.Printf("connection closed\n")
		os.Exit(0)
	}
	if err != nil {
		fmt.Printf("err: %v\n", err)
		os.Exit(1)
	}

	data := make([]byte, size)
	if _, err := io.ReadFull(br, data); err != nil {
		fmt.Printf("err: %v\n", err)
		os.Exit(1)
	}

	messagePb := &pb.DebugEvent{}
	if err = proto.Unmarshal(data, messagePb); err != nil {
		fmt.Printf("err: %v\n", err)
		return
	}

	json, err := protojson.Marshal(messagePb)
	if err != nil {
		fmt.Printf("json err: %s\n", err)
	} else {
		updateChannel <- json
	}
}

func send(conn net.Conn, request *pb.DebugRequest) {
	data, err := proto.Marshal(request)
	if err != nil {
		log.Fatal("marshaling error: ", err)
	}

	var buf [binary.MaxVarintLen64]byte
	v := binary.PutUvarint(buf[:], uint64(len(data)))
	conn.Write(buf[:v])
	conn.Write(data)
}

func startDebugger(updateChannel chan []byte, bps *pb.DebugRequest) {
	var conn net.Conn
	var err error

	fmt.Println("Trying to connect to a Starlark server...")
	for {
		conn, err = net.Dial("tcp", "localhost:7300")
		if err == nil {
			break
		}
		time.Sleep(1000 * time.Millisecond)
	}
	fmt.Println("Connected")
	globalConn = conn

	json, err := protojson.Marshal(bps)
	if err != nil {
		fmt.Printf("json err: %s\n", err)
	} else {
		updateChannel <- json
	}

	go func() {
		br := bufio.NewReader(conn)
		for {
			recv(conn, br, updateChannel)
		}
	}()
}

func getUpdates(w http.ResponseWriter, r *http.Request, updateChannel chan []byte) {
	response := <-updateChannel
	fmt.Fprintf(w, "%s", response)
}

func sendRequest(w http.ResponseWriter, r *http.Request) {
	body, err := ioutil.ReadAll(r.Body)
	if err != nil {
		fmt.Printf("request err: %s\n", err)
	}
	proto := &pb.DebugRequest{}
	err = protojson.Unmarshal(body, proto)
	if err != nil {
		fmt.Printf("unmarshal err: %s\n", err)
	}

	send(globalConn, proto)
}

func parseBreakpoints(args []string) *pb.DebugRequest {
	bps := []*pb.Breakpoint{}
	for _, a := range args {
		parts := strings.Split(a, ":")
		line := 0
		if len(parts) == 2 {
			line, _ = strconv.Atoi(parts[1])
		}
		loc := &pb.Location{Path: parts[0], LineNumber: uint32(line)}
		bps = append(bps, &pb.Breakpoint{Condition: &pb.Breakpoint_Location{Location: loc}})
	}
	return &pb.DebugRequest{Payload: &pb.DebugRequest_SetBreakpoints{
		SetBreakpoints: &pb.SetBreakpointsRequest{Breakpoint: bps},
	}}
}

func main() {
	flag.Parse()
	bps := parseBreakpoints(flag.Args())

	updateChannel := make(chan []byte)

	go startDebugger(updateChannel, bps)

	// TODO: restrict the set of files.
	http.Handle("/file/", http.StripPrefix("/file/", http.FileServer(http.Dir("/"))))
	http.HandleFunc("/updates",
		func(w http.ResponseWriter, r *http.Request) {
			getUpdates(w, r, updateChannel)
		})
	http.HandleFunc("/request", sendRequest)
	http.Handle("/", http.FileServer(http.Dir(".")))
	http.ListenAndServe(":8080", nil)
}
