
import zmq
import zmq.asyncio
import asyncio
import json

async def verify():
    context = zmq.asyncio.Context()
    
    # Simulate Slave (SUB)
    sub_socket = context.socket(zmq.SUB)
    sub_socket.connect("tcp://localhost:5556")
    sub_socket.subscribe("")
    
    # Simulate Master (PUSH)
    push_socket = context.socket(zmq.PUSH)
    push_socket.connect("tcp://localhost:5555")
    
    # Allow some time for connection
    await asyncio.sleep(1)
    
    msg = "OPEN|12345|0|EURUSD|1.0|1.1000|0|0|99999"
    print(f"Sending: {msg}")
    await push_socket.send_string(msg)
    
    try:
        # Wait for receive on SUB
        recv_msg = await asyncio.wait_for(sub_socket.recv_string(), timeout=2.0)
        print(f"Received back on SUB: {recv_msg}")
        if recv_msg == msg:
            print("VERIFICATION SUCCESS: Message looped back correctly.")
        else:
            print("VERIFICATION FAILED: Message mismatch.")
    except asyncio.TimeoutError:
        print("VERIFICATION FAILED: Timeout waiting for message on SUB.")
        
    sub_socket.close()
    push_socket.close()
    context.term()

if __name__ == "__main__":
    asyncio.run(verify())
